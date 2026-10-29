/**
 * Session content: text the model reaches by a short ref instead of a path.
 * Tool outputs too large for the context are saved as out-N; the extracted
 * text of file attachments is att-N. session_content_grep and
 * session_content_read search and read it by line.
 */
import { promises as fs, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { getDb } from '../../db/database.js'
import { getAppDataDir } from '../data-dir.js'
import { TOOL_OUTPUT_LIMITS } from '../runtime-limits.js'
import { listConversationFileAttachments } from '../artifacts/attachment-store.js'
import { readFileAttachmentText, type FileAttachmentArtifact } from '../artifacts/file-artifacts.js'
import { isSessionContentToolName } from './builtin/session-content-tool-names.js'

export interface SessionContentItem {
    ref: string
    kind: 'tool-output' | 'attachment'
    /** Tool name or attachment file name. */
    name: string
    path: string
}

interface OutputMeta {
    tool: string
    createdAt: number
    lines: number
    reformattedJson?: boolean
}

function conversationDirName(conversationId: string): string {
    return /^[A-Za-z0-9_-]{1,100}$/.test(conversationId)
        ? conversationId
        : createHash('sha256').update(conversationId).digest('hex').slice(0, 32)
}

export function getSessionContentDir(conversationId: string): string {
    return join(getAppDataDir(), 'session-content', conversationDirName(conversationId))
}

export function deleteSessionContent(conversationId: string): void {
    try { rmSync(getSessionContentDir(conversationId), { recursive: true, force: true }) } catch { /* best effort */ }
}

function listToolOutputs(conversationId: string): Array<SessionContentItem & { meta?: OutputMeta }> {
    const dir = getSessionContentDir(conversationId)
    let names: string[]
    try { names = readdirSync(dir) } catch { return [] }
    return names
        .map((name) => /^out-(\d+)\.txt$/.exec(name))
        .filter((match): match is RegExpExecArray => match !== null)
        .sort((a, b) => Number(a[1]) - Number(b[1]))
        .map((match) => {
            const ref = `out-${match[1]}`
            let meta: OutputMeta | undefined
            try { meta = JSON.parse(readFileSync(join(dir, `${ref}.json`), 'utf8')) as OutputMeta } catch { /* written after the text */ }
            return { ref, kind: 'tool-output' as const, name: meta?.tool ?? 'tool', path: join(dir, match[0]), meta }
        })
}

/** Everything the conversation's session content tools can reach, outputs first. */
export function listSessionContent(conversationId: string): SessionContentItem[] {
    if (!conversationId) return []
    return [...listToolOutputs(conversationId), ...listAttachmentContent(conversationId)]
}

function listAttachmentContent(conversationId: string): SessionContentItem[] {
    try {
        return listConversationFileAttachments(getDb(), conversationId)
            .filter((attachment) => attachment.sessionRef && existsSync(attachment.textPath))
            .map((attachment) => ({ ref: attachment.sessionRef!, kind: 'attachment' as const, name: attachment.name, path: attachment.textPath }))
    } catch {
        // No database, as in an executor without a stored conversation.
        return []
    }
}

/** Accept the forms models produce: "out-3", "OUT_3", "#out 3", or an attachment's attachmentId. */
export function normalizeSessionRef(input: string): string {
    const trimmed = input.trim().replace(/^["'#`]+|["'`]+$/g, '')
    const match = /^(out|att)[\s_-]*(\d+)$/i.exec(trimmed)
    return match ? `${match[1].toLowerCase()}-${Number(match[2])}` : trimmed
}

export function findSessionContent(conversationId: string, ref: string): SessionContentItem | undefined {
    const wanted = normalizeSessionRef(ref)
    const items = listSessionContent(conversationId)
    const direct = items.find((item) => item.ref === wanted)
    if (direct) return direct
    let attachments: ReturnType<typeof listConversationFileAttachments> = []
    try { attachments = listConversationFileAttachments(getDb(), conversationId) } catch { /* no database */ }
    const attachment = attachments.find((item) => item.id === wanted || item.assetId === wanted)
    return attachment?.sessionRef ? items.find((item) => item.ref === attachment.sessionRef) : undefined
}

export function splitLines(text: string): string[] {
    const lines = text.split('\n')
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    return lines.map((line) => line.endsWith('\r') ? line.slice(0, -1) : line)
}

/** Lines of the given item, for listings; tool outputs store their count. */
export function countSessionContentLines(item: SessionContentItem): number | undefined {
    const stored = item.kind === 'tool-output' ? (item as { meta?: OutputMeta }).meta?.lines : undefined
    if (stored !== undefined) return stored
    try { return splitLines(readFileSync(item.path, 'utf8')).length } catch { return undefined }
}

/** A listing of the session content with a usage example, for tool results and errors. */
export function describeSessionContent(conversationId: string): string {
    const items = listSessionContent(conversationId)
    if (!items.length) return 'This conversation has no session content yet. Refs (out-N for saved tool outputs, att-N for file attachments) appear in tool results and attachment notices.'
    const rows = items.map((item) => {
        const lines = countSessionContentLines(item)
        const what = item.kind === 'tool-output' ? `${item.name} output` : `${item.name} (attachment)`
        return `  ${item.ref}  ${what}${lines !== undefined ? `, ${lines.toLocaleString('en-US')} lines` : ''}`
    })
    return [`Session content in this conversation:`, ...rows, `Example: session_content_read {"ref": "${items[0].ref}", "offset": 1, "limit": 200}`].join('\n')
}

/** Pretty-print JSON packed on few long lines, so grep and line reads can work on it. */
function reformatJson(text: string): string | undefined {
    const trimmed = text.trim()
    if (!/^[[{]/.test(trimmed)) return undefined
    const lines = splitLines(trimmed).length
    if (trimmed.length / lines < 400) return undefined
    try { return JSON.stringify(JSON.parse(trimmed), null, 2) } catch { return undefined }
}

async function saveToolOutput(conversationId: string, toolName: string, text: string, meta: Omit<OutputMeta, 'tool' | 'createdAt'>): Promise<string> {
    const dir = getSessionContentDir(conversationId)
    await fs.mkdir(dir, { recursive: true })
    const highest = listToolOutputs(conversationId).reduce((max, item) => Math.max(max, Number(item.ref.slice(4))), 0)
    for (let number = highest + 1; ; number++) {
        const ref = `out-${number}`
        try {
            // wx claims the number; a concurrent save moves on to the next one.
            await fs.writeFile(join(dir, `${ref}.txt`), text, { encoding: 'utf8', flag: 'wx' })
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
            throw error
        }
        await fs.writeFile(join(dir, `${ref}.json`), JSON.stringify({ tool: toolName, createdAt: Date.now(), ...meta }))
        return ref
    }
}

export function renderLine(number: number, line: string, maxChars: number): string {
    if (line.length <= maxChars) return `${number}\t${line}`
    return `${number}\t${line.slice(0, maxChars)} [… ${(line.length - maxChars).toLocaleString('en-US')} more characters on this line; use session_content_grep to find text in it]`
}

function numberedWithin(lines: string[], start: number, maxChars: number, fromEnd = false): { text: string[]; first: number; last: number } {
    const text: string[] = []
    let used = 0
    let first = start
    let last = start - 1
    if (!fromEnd) {
        for (let i = start; i < lines.length; i++) {
            const rendered = renderLine(i + 1, lines[i], 500)
            if (text.length && used + rendered.length > maxChars) break
            text.push(rendered); used += rendered.length + 1; last = i
        }
        return { text, first, last }
    }
    last = lines.length - 1
    for (let i = lines.length - 1; i >= start; i--) {
        const rendered = renderLine(i + 1, lines[i], 500)
        if (text.length && used + rendered.length > maxChars) break
        text.unshift(rendered); used += rendered.length + 1; first = i
    }
    return { text, first, last }
}

function formatSize(chars: number): string {
    if (chars < 1000) return `${chars} characters`
    return chars >= 1_000_000 ? `${(chars / 1_000_000).toFixed(1)}M characters` : `${Math.round(chars / 1000)}k characters`
}

/**
 * Keep a tool output within the context budget. A larger output is saved as
 * session content (out-N) and replaced by its numbered first and last lines
 * and how to search and read the rest.
 */
export async function limitToolOutput(input: { conversationId: string; toolName: string; output: string }): Promise<{ output: string; ref?: string }> {
    const { output, toolName, conversationId } = input
    if (output.length <= TOOL_OUTPUT_LIMITS.inlineChars) return { output }

    const cut = (reason: string) => {
        const kept = output.slice(0, TOOL_OUTPUT_LIMITS.inlineChars).replace(/\n[^\n]*$/, '')
        return { output: `${kept}\n\n[Output cut at ${formatSize(kept.length)} of ${formatSize(output.length)}. ${reason}]` }
    }
    // Their own results are windows onto session content already.
    if (isSessionContentToolName(toolName)) return cut('Read a smaller range with offset and limit.')
    if (!conversationId) return cut('Narrow the request to get less output.')

    const reformatted = reformatJson(output)
    const text = reformatted ?? output
    const lines = splitLines(text)
    let ref: string
    try {
        ref = await saveToolOutput(conversationId, toolName, text, { lines: lines.length, ...(reformatted ? { reformattedJson: true } : {}) })
    } catch (error) {
        console.warn('[session-content] Failed to save large tool output:', error instanceof Error ? error.message : error)
        return cut('The full output could not be saved.')
    }

    const head = numberedWithin(lines, 0, TOOL_OUTPUT_LIMITS.previewHeadChars)
    const tail = numberedWithin(lines, head.last + 1, TOOL_OUTPUT_LIMITS.previewTailChars, true)
    const omitted = tail.first - head.last - 1
    const preview = [
        ...head.text,
        ...(omitted > 0 ? [`[… lines ${head.last + 2}–${tail.first} not shown …]`] : []),
        ...(tail.text.length && tail.first > head.last ? tail.text : []),
    ]
    const notice = [
        `[Output too large for the context (${lines.length.toLocaleString('en-US')} lines, ${formatSize(text.length)}). Saved in full as ${ref}${reformatted ? '; the JSON was reformatted to one value per line' : ''}.`,
        `Find lines: session_content_grep {"ref": "${ref}", "pattern": "<text or regex>"}`,
        `Read lines: session_content_read {"ref": "${ref}", "offset": 1, "limit": 200}`,
        'Use these instead of running the tool again. The first and last lines follow, numbered.]',
    ].join('\n')
    return { output: `${notice}\n\n${preview.join('\n')}`, ref }
}

/**
 * How a file attachment appears in the model's context: whole when it fits
 * the inline limit, otherwise its ref, how to search and read it, and its
 * numbered first lines.
 */
export function formatFileAttachmentForModel(file: FileAttachmentArtifact, inlineTextLimit: number): string | null {
    const text = readFileAttachmentText(file)
    if (text === null) return null
    const label = `[Attached file: ${file.name} (${file.sessionRef ? `${file.sessionRef}, ` : ''}attachmentId: ${file.id})]`
    if (file.textBytes <= inlineTextLimit) return `${label}\n${text}`

    const ref = file.sessionRef ?? file.id
    const lines = splitLines(text)
    const head = numberedWithin(lines, 0, TOOL_OUTPUT_LIMITS.previewHeadChars)
    return [
        label,
        `[Too large to include whole (${lines.length.toLocaleString('en-US')} lines, ${formatSize(text.length)}). It is session content ${ref}.`,
        `Find lines: session_content_grep {"ref": "${ref}", "pattern": "<text or regex>"}`,
        `Read lines: session_content_read {"ref": "${ref}", "offset": 1, "limit": 200}`,
        'The first lines follow, numbered.]',
        ...head.text,
        ...(head.last + 1 < lines.length ? [`[… lines ${head.last + 2}–${lines.length} not shown …]`] : []),
    ].join('\n')
}
