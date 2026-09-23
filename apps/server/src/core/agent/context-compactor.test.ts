import Database from 'better-sqlite3'
import { describe, expect, test, vi } from 'vitest'
import type { LLMGateway } from '../gateway/gateway.js'
import type { ChatMessage } from '../gateway/providers/base.provider.js'
import { applyCompactStrategy, COMPACT_EVENT_PREFIX, type CompactHistoryRow } from './context-compactor.js'

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
        controller.abort()

        await expect(run).rejects.toMatchObject({ name: 'AbortError' })
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
