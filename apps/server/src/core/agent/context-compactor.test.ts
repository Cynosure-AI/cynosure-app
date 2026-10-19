import Database from 'better-sqlite3'
import { describe, expect, test, vi } from 'vitest'
import type { LLMGateway } from '../gateway/gateway.js'
import type { ChatMessage } from '../gateway/providers/base.provider.js'
import {
    applyCompactStrategy,
    applyContextStrategy,
    COMPACT_EVENT_PREFIX,
    compactConversationNow,
    NothingToCompactError,
    isConversationCompacting,
    type CompactHistoryRow,
} from './context-compactor.js'

function database() {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE messages (id TEXT, conversation_id TEXT, role TEXT, content TEXT, content_blocks_json TEXT, created_at INTEGER)')
    return db
}

function row(id: string, role: string, content: string, createdAt: number): CompactHistoryRow {
    return { id, role, content, created_at: createdAt, tool_calls_json: null, tool_call_id: null }
}

describe('compact context replay', () => {
    test('replays from the summarized message boundary and preserves turn-local context', async () => {
        const marker = row('compact', 'system', `${COMPACT_EVENT_PREFIX}${JSON.stringify({
            summary: 'Earlier facts', compactedMessageCount: 2, model: 'summary-model',
            compactedThroughMessageId: 'old-answer', compactedThroughCreatedAt: 20,
        })}`, 100)
        const filteredRows = [
            row('old-user', 'user', 'old request', 10),
            row('old-answer', 'assistant', 'old answer', 20),
            row('active-user', 'user', 'raw active request', 30),
        ]
        const activeContent = [
            { type: 'text' as const, text: 'active request' },
            { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,abc' } },
        ]
        const messages: ChatMessage[] = [
            { role: 'system', content: 'instructions' },
            { role: 'user', content: 'retrieved fact', metadata: { contextKind: 'retrieved-memory', untrusted: true } },
            { role: 'user', content: activeContent },
        ]

        const result = await applyCompactStrategy({
            messages, historyRows: [...filteredRows, marker], filteredRows,
            contextWindow: 10_000, requestedOutputTokens: 100, thinkingEnabled: false,
            tools: [], gateway: {} as LLMGateway, providerId: undefined, responseModel: 'main-model',
            conversationId: 'conversation', db: database(), broadcast: vi.fn(),
        })

        expect(result.messages.some((message) => message.content === 'old answer')).toBe(false)
        expect(result.messages.some((message) => message.content === 'retrieved fact')).toBe(true)
        expect(result.messages.at(-1)?.content).toEqual(activeContent)
    })

    test('propagates cancellation and does not persist a compact marker', async () => {
        const db = database()
        const controller = new AbortController()
        const complete = vi.fn(({ signal }: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        }))
        const messages: ChatMessage[] = [
            { role: 'system', content: 'instructions' },
            { role: 'user', content: `old ${'x'.repeat(8_000)}` },
            { role: 'assistant', content: 'old answer' },
            { role: 'user', content: 'active request' },
        ]
        const run = applyCompactStrategy({
            messages, historyRows: [], filteredRows: [], contextWindow: 2_000,
            requestedOutputTokens: 100, thinkingEnabled: false, tools: [],
            gateway: { complete } as unknown as LLMGateway, providerId: undefined, responseModel: 'model',
            conversationId: 'conversation', db, broadcast: vi.fn(), signal: controller.signal,
        })
        expect(isConversationCompacting('conversation')).toBe(true)
        controller.abort()

        await expect(run).rejects.toMatchObject({ name: 'AbortError' })
        expect(isConversationCompacting('conversation')).toBe(false)
        expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 })
    })

    test('keeps retrieved evidence verbatim when creating a new summary and stores the replay boundary', async () => {
        const db = database()
        const filteredRows = [
            row('old-user', 'user', `old ${'x'.repeat(8_000)}`, 10),
            row('old-answer', 'assistant', 'old answer', 20),
            row('active-user', 'user', 'active request', 30),
        ]
        const messages: ChatMessage[] = [
            { role: 'system', content: 'instructions' },
            { role: 'user', content: 'exact retrieved evidence', metadata: { contextKind: 'retrieved-memory', untrusted: true } },
            { role: 'user', content: filteredRows[0].content },
            { role: 'assistant', content: 'old answer' },
            { role: 'user', content: 'active request' },
        ]
        const complete = vi.fn(async () => ({ content: 'summary', toolCalls: undefined }))

        const result = await applyCompactStrategy({
            messages, historyRows: filteredRows, filteredRows, contextWindow: 2_000,
            requestedOutputTokens: 100, thinkingEnabled: false, tools: [],
            gateway: { complete } as unknown as LLMGateway, providerId: undefined, responseModel: 'main-model',
            compactModel: 'compact-model', conversationId: 'conversation', db, broadcast: vi.fn(),
        })

        expect(result.messages.some((message) => message.content === 'exact retrieved evidence')).toBe(true)
        const stored = db.prepare('SELECT content FROM messages').get() as { content: string }
        const marker = JSON.parse(stored.content.slice(COMPACT_EVENT_PREFIX.length))
        expect(marker).toMatchObject({
            model: 'compact-model', compactedThroughMessageId: 'old-answer', compactedThroughCreatedAt: 20,
        })
    })
})

describe('manual compaction', () => {
    function settingsDatabase(contextStrategy: string) {
        const db = database()
        db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT)')
        db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)').run('chatRunSettings', JSON.stringify({ contextStrategy }))
        return db
    }

    /** History rows as `buildConversationHistory` returns them, including stored markers. */
    function history(db: ReturnType<typeof database>, rows: CompactHistoryRow[]) {
        const markers = db.prepare('SELECT id, role, content, created_at FROM messages').all() as CompactHistoryRow[]
        const historyRows = [...rows, ...markers.map(marker => ({ ...marker, tool_calls_json: null, tool_call_id: null }))]
            .sort((a, b) => a.created_at - b.created_at)
        const messages: ChatMessage[] = rows.map(item => ({ role: item.role as ChatMessage['role'], content: item.content }))
        return { messages, historyRows, filteredRows: rows }
    }

    const rows = [
        row('user-1', 'user', 'first request', 10),
        row('answer-1', 'assistant', 'first answer', 20),
    ]

    test('summarises the whole conversation and replays only what follows', async () => {
        const db = database()
        const broadcast = vi.fn()
        const complete = vi.fn(async () => ({ content: 'everything so far', toolCalls: undefined }))

        const result = await compactConversationNow({
            ...history(db, rows), gateway: { complete } as unknown as LLMGateway,
            providerId: 'provider', model: 'chat-model', conversationId: 'conversation', db, broadcast,
        })

        expect(result).toMatchObject({ compactedMessageCount: 2, model: 'chat-model' })
        expect(complete).toHaveBeenCalledWith(expect.objectContaining({ model: 'chat-model' }), 'provider')
        const events = broadcast.mock.calls.map(([, data]) => (data as { payload: { type: string } }).payload.type)
        expect(events).toEqual(['compact-start', 'compact-event'])
        const stored = db.prepare('SELECT content FROM messages').get() as { content: string }
        expect(JSON.parse(stored.content.slice(COMPACT_EVENT_PREFIX.length))).toMatchObject({
            summary: 'everything so far', compactedThroughMessageId: 'answer-1',
        })

        // The next turn starts from the summary, whatever the strategy or window.
        const next = history(db, [...rows, row('user-2', 'user', 'next request', Date.now() + 1)])
        const fitted = await applyContextStrategy({
            ...next, tools: [], gateway: {} as LLMGateway, providerId: undefined, responseModel: 'chat-model',
            conversationId: 'conversation', db, broadcast: vi.fn(),
        })
        expect(fitted.messages.map(message => message.content)).toEqual([
            expect.stringContaining('everything so far'),
            'next request',
        ])
    })

    test('a trimming strategy keeps the summary instead of the compacted rows', async () => {
        const db = settingsDatabase('sliding-window')
        const complete = vi.fn(async () => ({ content: 'everything so far', toolCalls: undefined }))
        await compactConversationNow({
            ...history(db, rows), gateway: { complete } as unknown as LLMGateway,
            providerId: undefined, model: 'chat-model', conversationId: 'conversation', db, broadcast: vi.fn(),
        })

        const fitted = await applyContextStrategy({
            ...history(db, [...rows, row('user-2', 'user', 'next request', Date.now() + 1)]),
            contextWindow: 100_000, tools: [], gateway: {} as LLMGateway, providerId: undefined,
            responseModel: 'chat-model', conversationId: 'conversation', db, broadcast: vi.fn(),
        })
        expect(fitted.strategy).toBe('sliding-window')
        expect(fitted.messages.some(message => message.content === 'first answer')).toBe(false)
        expect(fitted.messages.at(-1)?.content).toBe('next request')
    })

    test('refuses when nothing was said since the last compaction', async () => {
        const db = database()
        const complete = vi.fn(async () => ({ content: 'summary', toolCalls: undefined }))
        const input = { gateway: { complete } as unknown as LLMGateway, providerId: undefined, model: 'm', conversationId: 'conversation', db, broadcast: vi.fn() }
        await compactConversationNow({ ...history(db, rows), ...input })

        await expect(compactConversationNow({ ...history(db, rows), ...input })).rejects.toBeInstanceOf(NothingToCompactError)
        await expect(compactConversationNow({ ...history(db, []), ...input })).rejects.toBeInstanceOf(NothingToCompactError)
        expect(complete).toHaveBeenCalledOnce()
    })

    test('reports a failed summary and stores nothing', async () => {
        const db = database()
        const broadcast = vi.fn()
        const complete = vi.fn(async () => { throw new Error('provider down') })

        await expect(compactConversationNow({
            ...history(db, rows), gateway: { complete } as unknown as LLMGateway,
            providerId: undefined, model: 'm', conversationId: 'conversation', db, broadcast,
        })).rejects.toThrow('provider down')
        const events = broadcast.mock.calls.map(([, data]) => (data as { payload: { type: string } }).payload.type)
        expect(events).toEqual(['compact-start', 'compact-error'])
        expect(isConversationCompacting('conversation')).toBe(false)
        expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 })
    })
})
