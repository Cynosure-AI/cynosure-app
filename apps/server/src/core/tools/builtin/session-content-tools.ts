import { readFile } from 'node:fs/promises'
import type { ToolDefinition, ToolResult } from '../../gateway/providers/base.provider.js'
import { TOOL_OUTPUT_LIMITS } from '../../runtime-limits.js'
import {
    describeSessionContent,
    findSessionContent,
    listSessionContent,
    renderLine,
    splitLines,
    type SessionContentItem,
} from '../session-content.js'

const DEFAULT_READ_LINES = 200
const MAX_READ_LINES = 1000
const MAX_LINE_CHARS = 2000
const DEFAULT_GREP_RESULTS = 50
const MAX_GREP_RESULTS = 200
const GREP_EXCERPT_CHARS = 160
/** Leave room under the inline limit so these results are never saved again. */
const OUTPUT_BUDGET = TOOL_OUTPUT_LIMITS.inlineChars - 2_000

const REF_DESCRIPTION = 'Ref of the session content: out-N for a saved tool output, att-N for a file attachment, as shown in the tool result or attachment notice.'

function guidance(conversationId: string, problem: string): ToolResult {
    return { success: false, output: `${problem}\n\n${describeSessionContent(conversationId)}` }
}

function describe(item: SessionContentItem): string {
    return item.kind === 'tool-output' ? `${item.name} output` : `attachment ${item.name}`
}

async function readLines(item: SessionContentItem): Promise<string[]> {
    return splitLines(await readFile(item.path, 'utf8'))
}

function toInteger(value: unknown): number | undefined {
    const number = typeof value === 'string' && value.trim() ? Number(value) : value
    return typeof number === 'number' && Number.isFinite(number) ? Math.floor(number) : undefined
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Show a long line as an excerpt around its first match. */
function excerpt(line: string, regex: RegExp): string {
    if (line.length <= GREP_EXCERPT_CHARS * 2 + 80) return line
    regex.lastIndex = 0
    const match = regex.exec(line)
    const index = match?.index ?? 0
    const start = Math.max(0, index - GREP_EXCERPT_CHARS)
    const end = Math.min(line.length, index + (match?.[0].length ?? 0) + GREP_EXCERPT_CHARS)
    return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''} [column ${index + 1} of ${line.length.toLocaleString('en-US')}]`
}

interface GrepSection { item: SessionContentItem; matches: number; lines: string[]; firstMatch: number }

async function grepItems(items: SessionContentItem[], regex: RegExp, context: number, maxResults: number): Promise<{ sections: GrepSection[]; total: number; stopped: boolean }> {
    const sections: GrepSection[] = []
    let total = 0
    let used = 0
    let stopped = false
    for (const item of items) {
        let lines: string[]
        try { lines = await readLines(item) } catch { continue }
        const section: GrepSection = { item, matches: 0, lines: [], firstMatch: 0 }
        let shownUpTo = -1
        for (let i = 0; i < lines.length; i++) {
            regex.lastIndex = 0
            if (!regex.test(lines[i])) continue
            if (total >= maxResults || used > OUTPUT_BUDGET) { stopped = true; break }
            if (!section.matches) section.firstMatch = i + 1
            section.matches++
            total++
            const from = Math.max(i - context, shownUpTo + 1)
            if (section.lines.length && from > shownUpTo + 1) section.lines.push('--')
            for (let j = from; j <= Math.min(i + context, lines.length - 1); j++) {
                regex.lastIndex = 0
                const isMatch = j === i || regex.test(lines[j])
                const rendered = `${j + 1}${isMatch ? ':' : '-'} ${isMatch ? excerpt(lines[j], regex) : lines[j].slice(0, GREP_EXCERPT_CHARS * 2)}`
                section.lines.push(rendered)
                used += rendered.length + 1
            }
            shownUpTo = Math.min(i + context, lines.length - 1)
        }
        if (section.matches) sections.push(section)
        if (stopped) break
    }
    return { sections, total, stopped }
}

/** Grep and read session content by ref. Both only read the conversation's own content. */
export function makeSessionContentTools(conversationId: string): ToolDefinition[] {
    return [
        {
            name: 'session_content_grep',
            execution: { readOnly: true },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            description: 'Find lines in session content: tool outputs that were too large for the context (out-N) and file attachments (att-N). Returns matching lines with their line numbers; read around them with session_content_read. The pattern is a regular expression, or plain text if it is not a valid one; matching ignores case unless caseSensitive is true. Omit ref to search all session content.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Text or regular expression to find, for example "deleted_at" or "error|warning".' },
                    ref: { type: 'string', description: `${REF_DESCRIPTION} Omit to search everything.` },
                    context: { type: 'integer', minimum: 0, maximum: 10, description: 'Lines to show before and after each match (default 0).' },
                    caseSensitive: { type: 'boolean', description: 'Match case exactly (default false).' },
                    maxResults: { type: 'integer', minimum: 1, maximum: MAX_GREP_RESULTS, description: `Maximum matching lines (default ${DEFAULT_GREP_RESULTS}).` },
                },
                required: ['pattern'],
            },
            timeout: 30_000,
            execute: async (params: unknown) => {
                const args = (params ?? {}) as Record<string, unknown>
                const pattern = typeof args.pattern === 'string' ? args.pattern : ''
                if (!pattern) return guidance(conversationId, 'Missing "pattern": give the text or regular expression to find, for example {"ref": "out-1", "pattern": "error"}.')
                let items: SessionContentItem[]
                if (typeof args.ref === 'string' && args.ref.trim()) {
                    const item = findSessionContent(conversationId, args.ref)
                    if (!item) return guidance(conversationId, `No session content "${args.ref}".`)
                    items = [item]
                } else {
                    items = listSessionContent(conversationId)
                    if (!items.length) return guidance(conversationId, 'There is nothing to search.')
                }
                const context = Math.min(Math.max(toInteger(args.context) ?? 0, 0), 10)
                const maxResults = Math.min(Math.max(toInteger(args.maxResults) ?? DEFAULT_GREP_RESULTS, 1), MAX_GREP_RESULTS)
                const flags = args.caseSensitive === true ? '' : 'i'

                let regex: RegExp
                let note = ''
                try { regex = new RegExp(pattern, flags) }
                catch { regex = new RegExp(escapeRegExp(pattern), flags); note = ' (not a valid regular expression, so it was searched as plain text)' }
                let result = await grepItems(items, regex, context, maxResults)
                const literal = new RegExp(escapeRegExp(pattern), flags)
                if (!result.total && !note && literal.source !== regex.source) {
                    // A pattern like "foo(bar)" is valid regex but was meant literally.
                    result = await grepItems(items, literal, context, maxResults)
                    if (result.total) note = ' (no regular-expression matches, so it was searched as plain text)'
                }
                const where = items.length === 1 ? items[0].ref : 'session content'
                if (!result.total) {
                    return { success: true, output: `No lines in ${where} match "${pattern}". Try a shorter pattern, a single distinctive word, or another ref.\n\n${describeSessionContent(conversationId)}` }
                }
                const body = result.sections.map((section) =>
                    [`${section.item.ref} (${describe(section.item)}): ${section.matches} matching line${section.matches === 1 ? '' : 's'}`, ...section.lines].join('\n'))
                const first = result.sections[0]
                const footer = [
                    result.stopped ? `[Stopped at ${result.total} matching lines. Narrow the pattern, pass a ref, or raise maxResults.]` : '',
                    `Read around a match: session_content_read {"ref": "${first.item.ref}", "offset": ${Math.max(1, first.firstMatch - 20)}, "limit": 60}`,
                ].filter(Boolean)
                return { success: true, output: `${result.total} matching line${result.total === 1 ? '' : 's'} for "${pattern}"${note}:\n\n${body.join('\n\n')}\n\n${footer.join('\n')}` }
            },
        },
        {
            name: 'session_content_read',
            execution: { readOnly: true },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            description: `Read numbered lines of session content: tool outputs that were too large for the context (out-N) and file attachments (att-N). Lines come back as "<line>\\t<text>". Reads ${DEFAULT_READ_LINES} lines from offset by default, at most ${MAX_READ_LINES}; find the lines you need first with session_content_grep.`,
            parameters: {
                type: 'object',
                properties: {
                    ref: { type: 'string', description: `${REF_DESCRIPTION} Required.` },
                    offset: { type: 'integer', minimum: 1, description: 'First line to read, 1-based (default 1).' },
                    limit: { type: 'integer', minimum: 1, maximum: MAX_READ_LINES, description: `Number of lines to read (default ${DEFAULT_READ_LINES}).` },
                },
            },
            timeout: 30_000,
            execute: async (params: unknown) => {
                const args = (params ?? {}) as Record<string, unknown>
                if (typeof args.ref !== 'string' || !args.ref.trim()) return guidance(conversationId, 'Missing "ref": say which session content to read.')
                const item = findSessionContent(conversationId, args.ref)
                if (!item) return guidance(conversationId, `No session content "${args.ref}".`)
                let lines: string[]
                try { lines = await readLines(item) }
                catch { return guidance(conversationId, `${item.ref} can no longer be read.`) }
                const offset = Math.max(toInteger(args.offset) ?? 1, 1)
                const limit = Math.min(Math.max(toInteger(args.limit) ?? DEFAULT_READ_LINES, 1), MAX_READ_LINES)
                if (offset > lines.length) {
                    return { success: false, output: `${item.ref} has ${lines.length.toLocaleString('en-US')} lines, so offset ${offset} is past the end. Example: session_content_read {"ref": "${item.ref}", "offset": ${Math.max(1, lines.length - 49)}, "limit": 50}` }
                }
                const rendered: string[] = []
                let used = 0
                let last = offset - 1
                for (let i = offset - 1; i < Math.min(lines.length, offset - 1 + limit); i++) {
                    const line = renderLine(i + 1, lines[i], MAX_LINE_CHARS)
                    if (rendered.length && used + line.length > OUTPUT_BUDGET) break
                    rendered.push(line)
                    used += line.length + 1
                    last = i + 1
                }
                const header = `${item.ref} (${describe(item)}), lines ${offset}–${last} of ${lines.length.toLocaleString('en-US')}:`
                const footer = last < lines.length
                    ? `[More: session_content_read {"ref": "${item.ref}", "offset": ${last + 1}, "limit": ${limit}}]`
                    : `[End of ${item.ref}.]`
                return { success: true, output: `${header}\n${rendered.join('\n')}\n${footer}` }
            },
        },
    ]
}
