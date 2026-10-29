import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { closeDb, getDb } from '../../db/database.js'
import { getAppDataDir } from '../data-dir.js'
import { TOOL_OUTPUT_LIMITS } from '../runtime-limits.js'
import { AgentExecutor } from '../agent/agent-executor.js'
import type { LLMGateway } from '../gateway/gateway.js'
import type { ToolCall, ToolDefinition } from '../gateway/providers/base.provider.js'
import { assignAttachmentSessionRefs, listConversationFileAttachments } from '../artifacts/attachment-store.js'
import type { FileAttachmentArtifact } from '../artifacts/file-artifacts.js'
import { deleteSessionContent, formatFileAttachmentForModel, getSessionContentDir, limitToolOutput, listSessionContent, normalizeSessionRef } from './session-content.js'
import { makeSessionContentTools } from './builtin/session-content-tools.js'
import { isSystemAutoApprovedTool } from './tool-policy.js'

const CONVERSATION = 'session-content-test'

let sandbox: string
let previousDataDir: string | undefined

function bigOutput(lines = 5000): string {
    return Array.from({ length: lines }, (_, index) => `line ${index + 1} ${'x'.repeat(20)}`).join('\n')
}

function tools() {
    const [grep, read] = makeSessionContentTools(CONVERSATION)
    return { grep, read }
}

async function addAttachment(id: string, name: string, text: string, createdAt: number, assetId = `asset-${id}`): Promise<string> {
    const textPath = path.join(sandbox, `${id}.txt`)
    await fs.writeFile(textPath, text)
    const db = getDb()
    db.pragma('foreign_keys = OFF')
    db.prepare(`INSERT OR IGNORE INTO attachment_assets (id, name, original_path, text_path, size_bytes, text_bytes, chunk_count, metadata_json, created_at)
        VALUES (?, ?, ?, ?, 1, ?, 0, '{}', 0)`).run(assetId, name, textPath, textPath, text.length)
    db.prepare(`INSERT INTO message_attachments (id, message_id, conversation_id, kind, name, original_path, text_path, size_bytes, text_bytes, chunk_count, metadata_json, created_at, asset_id)
        VALUES (?, ?, ?, 'file', ?, ?, ?, 1, ?, 0, '{}', ?, ?)`).run(id, `msg-${id}`, CONVERSATION, name, textPath, textPath, text.length, createdAt, assetId)
    db.pragma('foreign_keys = ON')
    return textPath
}

beforeEach(async () => {
    closeDb()
    previousDataDir = process.env.CYNOSURE_DATA_DIR
    sandbox = await fs.mkdtemp(path.join(tmpdir(), 'cynosure-session-content-'))
    process.env.CYNOSURE_DATA_DIR = sandbox
    if (getAppDataDir() !== path.join(sandbox, 'data')) throw new Error('Test database is not isolated.')
})

afterEach(async () => {
    closeDb()
    if (previousDataDir === undefined) delete process.env.CYNOSURE_DATA_DIR
    else process.env.CYNOSURE_DATA_DIR = previousDataDir
    await fs.rm(sandbox, { recursive: true, force: true })
})

describe('limitToolOutput', () => {
    it('leaves output within the limit unchanged', async () => {
        expect(await limitToolOutput({ conversationId: CONVERSATION, toolName: 'mcp_tool', output: 'small' })).toEqual({ output: 'small' })
    })

    it('saves a large output as out-N with numbered first and last lines and example calls', async () => {
        const output = bigOutput()
        const first = await limitToolOutput({ conversationId: CONVERSATION, toolName: 'shell_execute', output })
        const second = await limitToolOutput({ conversationId: CONVERSATION, toolName: 'mcp__notes__list', output })
        expect(first.ref).toBe('out-1')
        expect(second.ref).toBe('out-2')
        expect(first.output.length).toBeLessThan(TOOL_OUTPUT_LIMITS.previewHeadChars + TOOL_OUTPUT_LIMITS.previewTailChars + 1500)
        expect(first.output).toContain('5,000 lines')
        expect(first.output).toContain('session_content_grep {"ref": "out-1", "pattern": "<text or regex>"}')
        expect(first.output).toContain('1\tline 1 ')
        expect(first.output).toContain('5000\tline 5000 ')
        expect(first.output).not.toContain(sandbox)
        expect(await fs.readFile(path.join(getSessionContentDir(CONVERSATION), 'out-1.txt'), 'utf8')).toBe(output)
        expect(listSessionContent(CONVERSATION).map((item) => [item.ref, item.name])).toEqual([['out-1', 'shell_execute'], ['out-2', 'mcp__notes__list']])
    })

    it('reformats JSON packed on one line so lines are useful', async () => {
        const payload = { notes: Array.from({ length: 2000 }, (_, id) => ({ id, deleted_at: id === 1234 ? '2026-10-01' : null })) }
        const { ref, output } = await limitToolOutput({ conversationId: CONVERSATION, toolName: 'notes', output: JSON.stringify(payload) })
        expect(output).toContain('the JSON was reformatted to one value per line')
        const result = await tools().grep.execute({ ref, pattern: '"deleted_at": "20' })
        expect(result.output).toContain('1 matching line for')
        expect(result.output).toMatch(/\d+: +"deleted_at": "2026-10-01"/)
    })

    it('cuts results of the session content tools instead of saving them again', async () => {
        const result = await limitToolOutput({ conversationId: CONVERSATION, toolName: 'session_content_read', output: bigOutput() })
        expect(result.ref).toBeUndefined()
        expect(result.output).toContain('Read a smaller range with offset and limit.')
    })

    it('deletes saved outputs with the conversation', async () => {
        await limitToolOutput({ conversationId: CONVERSATION, toolName: 'tool', output: bigOutput() })
        deleteSessionContent(CONVERSATION)
        expect(listSessionContent(CONVERSATION)).toEqual([])
    })
})

describe('session content tools', () => {
    it('are auto-approved internal tools', () => {
        const { grep, read } = tools()
        expect(isSystemAutoApprovedTool(grep.name) && isSystemAutoApprovedTool(read.name)).toBe(true)
    })

    it('read numbered lines with a continuation hint', async () => {
        await limitToolOutput({ conversationId: CONVERSATION, toolName: 'shell_execute', output: bigOutput() })
        const result = await tools().read.execute({ ref: 'OUT_1', offset: '10', limit: 2 })
        expect(result.success, result.output).toBe(true)
        expect(result.output).toBe([
            'out-1 (shell_execute output), lines 10–11 of 5,000:',
            `10\tline 10 ${'x'.repeat(20)}`,
            `11\tline 11 ${'x'.repeat(20)}`,
            '[More: session_content_read {"ref": "out-1", "offset": 12, "limit": 2}]',
        ].join('\n'))
    })

    it('explain a missing or unknown ref with what is available and an example', async () => {
        await limitToolOutput({ conversationId: CONVERSATION, toolName: 'shell_execute', output: bigOutput() })
        const missing = await tools().read.execute({ limit: 60, size: 48, tileSize: 160 })
        expect(missing.success).toBe(false)
        expect(missing.output).toContain('Missing "ref"')
        expect(missing.output).toContain('out-1  shell_execute output, 5,000 lines')
        expect(missing.output).toContain('Example: session_content_read {"ref": "out-1"')

        const unknown = await tools().grep.execute({ ref: 'out-9', pattern: 'x' })
        expect(unknown.output).toContain('No session content "out-9".')
        const past = await tools().read.execute({ ref: 'out-1', offset: 9000 })
        expect(past.output).toContain('has 5,000 lines, so offset 9000 is past the end')
    })

    it('grep ignores case, falls back to plain text and suggests where to read', async () => {
        await limitToolOutput({ conversationId: CONVERSATION, toolName: 'logs', output: `${bigOutput()}\nERROR: call(foo) failed [x` })
        const regex = await tools().grep.execute({ ref: 'out-1', pattern: 'error: call' })
        expect(regex.output).toContain('5001: ERROR: call(foo) failed [x')
        expect(regex.output).toContain('session_content_read {"ref": "out-1", "offset": 4981, "limit": 60}')

        const invalid = await tools().grep.execute({ ref: 'out-1', pattern: 'failed [x' })
        expect(invalid.output).toContain('searched as plain text')
        expect(invalid.output).toContain('5001: ')

        const literal = await tools().grep.execute({ ref: 'out-1', pattern: 'call(foo)' })
        expect(literal.output).toContain('no regular-expression matches, so it was searched as plain text')

        const context = await tools().grep.execute({ ref: 'out-1', pattern: '^line 2500 ', context: 1 })
        expect(context.output).toContain('2499- line 2499')
        expect(context.output).toContain('2500: line 2500')
        expect(context.output).toContain('2501- line 2501')
    })

    it('grep without a ref searches everything and stops at maxResults', async () => {
        await limitToolOutput({ conversationId: CONVERSATION, toolName: 'one', output: bigOutput() })
        await limitToolOutput({ conversationId: CONVERSATION, toolName: 'two', output: bigOutput() })
        const all = await tools().grep.execute({ pattern: '^line 77 ' })
        expect(all.output).toContain('2 matching lines')
        expect(all.output).toContain('out-1 (one output)')
        expect(all.output).toContain('out-2 (two output)')
        const capped = await tools().grep.execute({ ref: 'out-1', pattern: 'line', maxResults: 3 })
        expect(capped.output).toContain('[Stopped at 3 matching lines.')
    })

    it('grep shows long lines as an excerpt around the match', async () => {
        const line = `${'a'.repeat(5000)}NEEDLE${'b'.repeat(5000)}`
        await limitToolOutput({ conversationId: CONVERSATION, toolName: 'html', output: `${line}\n${bigOutput()}` })
        const result = await tools().grep.execute({ ref: 'out-1', pattern: 'needle' })
        expect(result.output).toContain('NEEDLE')
        expect(result.output).toContain('[column 5001 of 10,006]')
        expect(result.output.length).toBeLessThan(1000)
    })
})

describe('attachments as session content', () => {
    it('gives attachments fixed att-N refs, shared by repeated uploads of the same file', async () => {
        await addAttachment('a1', 'report.pdf', 'Invoice 4711\nTotal: 99 EUR\n', 1)
        await addAttachment('a2', 'notes.md', 'first\nsecond\n', 2)
        await addAttachment('a3', 'report.pdf', 'Invoice 4711\nTotal: 99 EUR\n', 3, 'asset-a1')
        expect(listConversationFileAttachments(getDb(), CONVERSATION).map((item) => [item.name, item.sessionRef])).toEqual([['report.pdf', 'att-1'], ['notes.md', 'att-2']])

        const incoming: FileAttachmentArtifact[] = [
            { id: 'new-1', assetId: 'asset-a2', name: 'notes.md', originalPath: '', textPath: '', sizeBytes: 0, textBytes: 0 },
            { id: 'new-2', assetId: 'asset-new', name: 'data.csv', originalPath: '', textPath: '', sizeBytes: 0, textBytes: 0 },
        ]
        assignAttachmentSessionRefs(getDb(), CONVERSATION, incoming)
        expect(incoming.map((item) => item.sessionRef)).toEqual(['att-2', 'att-3'])
    })

    it('greps and reads attachment text by ref and lists refs in attachment_search', async () => {
        await addAttachment('a1', 'report.pdf', 'Invoice 4711\nTotal: 99 EUR\n', 1)
        const grep = await tools().grep.execute({ ref: 'att-1', pattern: 'total' })
        expect(grep.output).toContain('att-1 (attachment report.pdf): 1 matching line')
        expect(grep.output).toContain('2: Total: 99 EUR')
        const read = await tools().read.execute({ ref: 'a1' })
        expect(read.output).toContain('att-1 (attachment report.pdf), lines 1–2 of 2:')
        expect(read.output).toContain('[End of att-1.]')
        expect(listSessionContent(CONVERSATION).map((item) => [item.ref, item.kind, item.name])).toEqual([['att-1', 'attachment', 'report.pdf']])
    })

    it('shows a large attachment as its ref, sample calls and first lines', async () => {
        await addAttachment('a1', 'tax.pdf', bigOutput(), 1)
        const [file] = listConversationFileAttachments(getDb(), CONVERSATION)
        const text = formatFileAttachmentForModel(file, 1000)!
        expect(text).toMatch(/^\[Attached file: tax\.pdf \(att-1, attachmentId: a1\)\]\n\[Too large to include whole \(5,000 lines/)
        expect(text).toContain('session_content_grep {"ref": "att-1"')
        expect(text).toContain('1\tline 1 ')
        expect(text.length).toBeLessThan(TOOL_OUTPUT_LIMITS.previewHeadChars + 1000)
        expect(formatFileAttachmentForModel({ ...file, textBytes: 10 }, 1000)).toBe(`[Attached file: tax.pdf (att-1, attachmentId: a1)]\n${bigOutput()}`)
    })

    it('normalizes the ref forms models write', () => {
        expect(normalizeSessionRef(' "#OUT_3" ')).toBe('out-3')
        expect(normalizeSessionRef('att 12')).toBe('att-12')
        expect(normalizeSessionRef('some-attachment-id')).toBe('some-attachment-id')
    })
})

describe('executor output limit', () => {
    it('saves a large result and offers the session content tools', async () => {
        const output = bigOutput()
        const bigTool: ToolDefinition = {
            name: 'big_tool',
            description: 'Returns a lot of text.',
            parameters: { type: 'object', properties: {} },
            timeout: 5_000,
            execute: async () => ({ success: true, output }),
        }
        const offered = [bigTool]
        const executor = new AgentExecutor({ gateway: {} as LLMGateway, tools: offered, conversationId: CONVERSATION, broadcast: () => undefined })
        const call: ToolCall = { id: 'big', type: 'function', function: { name: 'big_tool', arguments: '{}' } }
        const [result] = await (executor as unknown as { executeToolCalls: (calls: ToolCall[]) => Promise<{ output: string; success: boolean }[]> }).executeToolCalls([call])

        expect(result.success).toBe(true)
        expect(result.output).toContain('Saved in full as out-1')
        expect(offered.map((tool) => tool.name)).toEqual(['big_tool', 'session_content_grep', 'session_content_read'])
    })
})
