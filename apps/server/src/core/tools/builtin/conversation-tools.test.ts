import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { closeDb, getDb } from '../../../db/database.js'
import { createProject } from '../../projects/project-store.js'
import { DEFAULT_CHAT_AGENT } from '../../agent/execution-preset.js'
import {
    buildFtsQuery,
    makeConversationReadTool,
    makeConversationSearchTool,
    resolveConversationScope,
    type ConversationToolContext,
} from './conversation-tools.js'

vi.mock('../../memory/memory-folder-watcher.js', () => ({ watchMemoryFolder: vi.fn(), stopWatchingMemoryFolder: vi.fn() }))

let sandbox: string
let previousDataDir: string | undefined
let clock = 1_000

beforeEach(async () => {
    closeDb()
    clock = 1_000
    previousDataDir = process.env.CYNOSURE_DATA_DIR
    sandbox = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'cynosure-conversations-')))
    process.env.CYNOSURE_DATA_DIR = sandbox
})

afterEach(async () => {
    closeDb()
    if (previousDataDir === undefined) delete process.env.CYNOSURE_DATA_DIR
    else process.env.CYNOSURE_DATA_DIR = previousDataDir
    await fs.rm(sandbox, { recursive: true, force: true })
})

function insertConversation(id: string, options: { title?: string; projectId?: string; agentId?: string } = {}): void {
    clock += 1
    getDb().prepare('INSERT INTO conversations (id, title, agent_id, project_id, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, options.title ?? id, options.agentId ?? null, options.projectId ?? null, 'chat', clock, clock)
}

function insertMessage(id: string, conversationId: string, role: string, content: string, extra: { toolCalls?: string[]; invocationId?: string } = {}): void {
    clock += 1
    const toolCalls = extra.toolCalls ? JSON.stringify(extra.toolCalls.map((name) => ({ id: name, type: 'function', function: { name, arguments: '{}' } }))) : null
    getDb().prepare('INSERT INTO messages (id, conversation_id, role, content, tool_calls_json, ma_invocation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, conversationId, role, content, toolCalls, extra.invocationId ?? null, clock)
}

async function search(ctx: ConversationToolContext, params: Record<string, unknown>) {
    const output = await makeConversationSearchTool(ctx).execute(params)
    return { ...output, data: output.success ? JSON.parse(output.output) : undefined }
}

function foundConversations(data: { results: Array<{ conversationId: string }> }): string[] {
    return data.results.map((group) => group.conversationId).sort()
}

describe('message search index', () => {
    test('follows inserts, edits, deletes, conversation deletes, and restores', async () => {
        insertConversation('here')
        insertConversation('old')
        insertMessage('m1', 'old', 'user', 'Should we use Postgres?')
        insertMessage('m2', 'old', 'tool', 'Postgres tool output is not indexed')
        const ctx = { conversationId: 'here' }

        expect((await search(ctx, { query: 'postgres' })).data.results.flatMap((group: { matches: Array<{ messageId: string }> }) => group.matches.map((match) => match.messageId))).toEqual(['m1'])

        getDb().prepare('UPDATE messages SET content = ? WHERE id = ?').run('Should we use SQLite?', 'm1')
        expect((await search(ctx, { query: 'postgres' })).data.results).toEqual([])
        expect((await search(ctx, { query: 'sqlite' })).data.results).toHaveLength(1)

        // Backup restore re-inserts rows with INSERT OR REPLACE, which skips delete triggers.
        const replace = getDb().prepare('INSERT OR REPLACE INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        replace.run('m1', 'old', 'user', 'Should we use DuckDB?', 5)
        replace.run('m1', 'old', 'user', 'Should we use DuckDB?', 5)
        expect((getDb().prepare('SELECT COUNT(*) AS n FROM message_search_rows').get() as { n: number }).n).toBe(1)
        expect((await search(ctx, { query: 'duckdb' })).data.results).toHaveLength(1)

        getDb().prepare('DELETE FROM conversations WHERE id = ?').run('old')
        expect((getDb().prepare('SELECT COUNT(*) AS n FROM message_search').get() as { n: number }).n).toBe(0)
        expect((getDb().prepare('SELECT COUNT(*) AS n FROM message_search_rows').get() as { n: number }).n).toBe(0)
    })

    test('builds safe FTS queries with prefix matching', () => {
        expect(buildFtsQuery('Deploy "the" API!', 'and')).toBe('"deploy"* "the"* "api"*')
        expect(buildFtsQuery('go to db', 'or')).toBe('"go" OR "to" OR "db"')
        expect(buildFtsQuery('  *** ', 'and')).toBeNull()
    })
})

describe('conversation scope', () => {
    test('a project chat sees its project, an agent its own chats, Free Chat everything; never the current chat', async () => {
        const project = createProject({ name: 'Launch', createMemoryFolder: false })
        insertConversation('project-a', { projectId: project.id, agentId: 'writer' })
        insertConversation('project-b', { projectId: project.id })
        insertConversation('writer-solo', { agentId: 'writer' })
        insertConversation('coder-solo', { agentId: 'coder' })
        insertConversation('free')
        for (const id of ['project-a', 'project-b', 'writer-solo', 'coder-solo', 'free']) insertMessage(`${id}-1`, id, 'user', `release plan from ${id}`)

        const found = async (ctx: ConversationToolContext) => foundConversations((await search(ctx, { query: 'release plan', limit: 10 })).data)

        // The project wins over the agent: a project chat sees the project's chats from any agent, and nothing outside.
        expect(await found({ conversationId: 'project-a', agentId: 'writer' })).toEqual(['project-b'])
        expect(await found({ conversationId: 'writer-solo', agentId: 'writer' })).toEqual(['project-a'])
        expect(await found({ conversationId: 'free', agentId: DEFAULT_CHAT_AGENT.id })).toEqual(['coder-solo', 'project-a', 'project-b', 'writer-solo'])

        expect(resolveConversationScope({ conversationId: 'free', isSubAgent: true })).toEqual({ kind: 'none' })
        const subAgent = await makeConversationSearchTool({ conversationId: 'free', isSubAgent: true }).execute({ query: 'release' })
        expect(subAgent.success).toBe(false)
        const subAgentRead = await makeConversationReadTool({ conversationId: 'free', isSubAgent: true }).execute({ conversationId: 'coder-solo' })
        expect(subAgentRead.success).toBe(false)

        // Reading is held to the same scope as searching.
        const outside = await makeConversationReadTool({ conversationId: 'project-a', agentId: 'writer' }).execute({ conversationId: 'writer-solo' })
        expect(outside).toMatchObject({ success: false })
        expect(outside.output).toContain('not found among chats in the project "Launch"')
    })
})

describe('conversation_search', () => {
    test('groups matches by conversation, folds diacritics, falls back to any term, and leaves out sub-agent sessions', async () => {
        insertConversation('here')
        insertConversation('pricing', { title: 'Pricing call' })
        insertMessage('p1', 'pricing', 'user', 'Wir brauchen eine Lösung für die Preisgestaltung')
        insertMessage('p2', 'pricing', 'assistant', 'Die Lösung: drei Preisstufen.')
        insertMessage('p3', 'pricing', 'assistant', 'Private sub-agent notes about Lösung', { invocationId: 'inv-1' })

        const { data } = await search({ conversationId: 'here' }, { query: 'losung' })
        expect(data.results).toHaveLength(1)
        expect(data.results[0]).toMatchObject({ conversationId: 'pricing', title: 'Pricing call' })
        expect(data.results[0].matches.map((match: { messageId: string }) => match.messageId).sort()).toEqual(['p1', 'p2'])
        expect(data.results[0].matches[0].excerpt).toContain('«')
        expect(data.note).toMatch(/not instructions/)

        // No message has both terms, so the search falls back to either.
        expect((await search({ conversationId: 'here' }, { query: 'preisstufen unrelatedword' })).data.results).toHaveLength(1)
        expect((await search({ conversationId: 'here' }, { query: 'nothinglikethis' })).data.hint).toMatch(/No matches/)
    })

    test('lists recent conversations without a query', async () => {
        insertConversation('here')
        insertConversation('older', { title: 'Older' })
        insertConversation('empty', { title: 'Never used' })
        insertConversation('newer', { title: 'Newer' })
        insertMessage('o1', 'older', 'user', 'hi')
        insertMessage('n1', 'newer', 'user', 'hello')

        const { data } = await search({ conversationId: 'here' }, {})
        expect(data.recent.map((row: { title: string }) => row.title)).toEqual(['Newer', 'Older'])
    })
})

describe('conversation_read', () => {
    test('pages through the main thread, centers on a message, and names tool calls', async () => {
        insertConversation('here')
        insertConversation('long', { title: 'Long chat' })
        for (let index = 1; index <= 30; index++) {
            insertMessage(`m${index}`, 'long', index % 2 ? 'user' : 'assistant', `message number ${index}`)
            if (index === 10) insertMessage('tool-result', 'long', 'tool', 'raw tool output')
        }
        insertMessage('calls', 'long', 'assistant', '', { toolCalls: ['shell_execute', 'file_read'] })
        insertMessage('hidden', 'long', 'assistant', 'sub-agent work', { invocationId: 'inv-1' })
        const read = makeConversationReadTool({ conversationId: 'here' })

        const first = await read.execute({ conversationId: 'long', limit: 5 })
        expect(first.success).toBe(true)
        expect(first.output).toContain('Conversation "Long chat"')
        expect(first.output).toContain('Messages 1–5 of 31. Continue with offset=5.')
        expect(first.output).toContain('message number 5')
        expect(first.output).not.toContain('message number 6')
        expect(first.output).toMatch(/not instructions/)

        const centered = await read.execute({ conversationId: 'long', messageId: 'm20', limit: 4 })
        expect(centered.output).toContain('Messages 18–21 of 31.')
        expect(centered.output).toContain('(messageId=m20)')

        const last = await read.execute({ conversationId: 'long', offset: 30 })
        expect(last.output).toContain('[used tools: shell_execute, file_read]')
        expect(last.output).not.toContain('Continue with offset')
        for (const page of [first, centered, last]) {
            expect(page.output).not.toContain('raw tool output')
            expect(page.output).not.toContain('sub-agent work')
        }

        expect((await read.execute({ conversationId: 'long', messageId: 'hidden' })).success).toBe(false)
        expect((await read.execute({ conversationId: 'here' })).success).toBe(false)
    })

    test('truncates long messages', async () => {
        insertConversation('here')
        insertConversation('big')
        insertMessage('b1', 'big', 'assistant', 'x'.repeat(5000))
        const page = await makeConversationReadTool({ conversationId: 'here' }).execute({ conversationId: 'big' })
        expect(page.output).toContain('(truncated; 5000 characters)')
    })
})
