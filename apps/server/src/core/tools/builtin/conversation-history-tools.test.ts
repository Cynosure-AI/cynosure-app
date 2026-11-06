import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb } from '../../../db/database.js'
import { saveConversationSearchConfig } from '../../chat/conversation-search-settings.js'
import { isReadOnlyModeTool } from '../tool-policy.js'
import { isConversationHistoryAvailable, makeConversationHistoryTools, parseTimeBound } from './conversation-history-tools.js'

const day = (date: string) => new Date(`${date}T12:00:00`).getTime()

describe('parseTimeBound', () => {
    const now = day('2026-11-06')

    test('reads dates, date-times and relative ages', () => {
        expect(parseTimeBound(undefined, 'since')).toBeUndefined()
        expect(parseTimeBound('2026-10-01', 'since')).toBe(new Date(2026, 9, 1).getTime())
        expect(parseTimeBound('2026-10-01', 'until')).toBe(new Date(2026, 9, 2).getTime())
        expect(parseTimeBound('2026-10-01T08:30:00Z', 'since')).toBe(Date.parse('2026-10-01T08:30:00Z'))
        expect(parseTimeBound('7d', 'since', now)).toBe(now - 7 * 24 * 60 * 60 * 1000)
        expect(parseTimeBound('2w', 'since', now)).toBe(now - 14 * 24 * 60 * 60 * 1000)
        expect(parseTimeBound('last tuesday', 'since')).toBeNull()
    })
})

describe('conversation history tools', () => {
    let directory = ''

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'cynosure-conversation-history-'))
        process.env.CYNOSURE_DATA_DIR = directory
        const db = getDb()
        const conversation = db.prepare('INSERT INTO conversations (id, title, agent_id, temporary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        conversation.run('current', 'Now', null, 0, 1, 100)
        conversation.run('deploy', 'Deploying', null, 0, 1, 50)
        conversation.run('agent-chat', 'Agent work', 'agent-1', 0, 1, 60)
        conversation.run('incognito', 'Secret', null, 1, 1, 70)
        const message = db.prepare('INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        message.run('now-1', 'current', 'user', 'What did we say about docker?', day('2026-11-06'))
        for (let i = 1; i <= 20; i++) {
            const content = i === 10 ? 'Use docker compose with the postgres volume.' : `Deploy step ${i}`
            message.run(`d${i}`, 'deploy', i % 2 ? 'user' : 'assistant', content, day('2026-10-01') + i)
        }
        message.run('d-tool', 'deploy', 'tool', 'docker tool output', day('2026-10-01') + 30)
        message.run('a1', 'agent-chat', 'user', 'Agent docker notes', day('2026-11-01'))
        message.run('s1', 'incognito', 'user', 'secret docker plan', day('2026-11-02'))
    })

    afterEach(async () => {
        closeDb()
        delete process.env.CYNOSURE_DATA_DIR
        await rm(directory, { recursive: true, force: true })
    })

    function tools(agentId?: string) {
        const [search, read] = makeConversationHistoryTools({ conversationId: 'current', agentId })
        return { search, read }
    }

    test('are read-only internal tools', () => {
        const { search, read } = tools()
        expect([search.name, read.name]).toEqual(['conversation_search', 'conversation_read'])
        expect(isReadOnlyModeTool(search) && isReadOnlyModeTool(read)).toBe(true)
    })

    test('are available only when enabled and outside incognito chats', () => {
        expect(isConversationHistoryAvailable('current')).toBe(false)
        saveConversationSearchConfig({ enabled: true })
        expect(isConversationHistoryAvailable('current')).toBe(true)
        expect(isConversationHistoryAvailable('incognito')).toBe(false)
    })

    test('Cyno searches every visible conversation except the current one', async () => {
        const result = await tools().search.execute({ query: 'docker' })
        expect(result.success).toBe(true)
        expect(result.output).toContain('conversationId: deploy · messageId: d10 · assistant')
        expect(result.output).toContain('**docker**')
        expect(result.output).toContain('conversationId: agent-chat')
        expect(result.output).not.toContain('conversationId: current')
        expect(result.output).not.toContain('incognito')
        expect(result.output).not.toContain('d-tool')
    })

    test('an agent only searches its own conversations', async () => {
        const result = await tools('agent-1').search.execute({ query: 'docker' })
        expect(result.output).toContain('conversationId: agent-chat')
        expect(result.output).not.toContain('conversationId: deploy')
    })

    test('filters by time and falls back to any word', async () => {
        expect((await tools().search.execute({ query: 'docker', since: '2026-10-15' })).output).not.toContain('conversationId: deploy')
        const fallback = await tools().search.execute({ query: 'postgres kubernetes' })
        expect(fallback.output).toContain('match any of them')
        expect(fallback.output).toContain('messageId: d10')
        const invalid = await tools().search.execute({ query: 'docker', since: 'someday' })
        expect(invalid.success).toBe(false)
    })

    test('lists recent conversations without a query', async () => {
        const result = await tools().search.execute({ since: '2026-09-01' })
        expect(result.output.indexOf('agent-chat')).toBeLessThan(result.output.indexOf('deploy'))
        expect(result.output).toContain('messageId: d1 · user')
        expect(result.output).not.toContain('incognito')
    })

    test('reads a window around a message with continuation hints', async () => {
        const result = await tools().read.execute({ conversationId: 'deploy', messageId: 'd10', window: 2 })
        expect(result.success).toBe(true)
        expect(result.output).toContain('messages 8–12 of 20')
        expect(result.output).toContain('[d10] assistant')
        expect(result.output).toContain('← match')
        expect(result.output).not.toContain('d-tool')
        expect(result.output).toContain('"messageId": "d5", "window": 2')
        expect(result.output).toContain('"messageId": "d15", "window": 2')

        const before = await tools().read.execute({ conversationId: 'deploy', messageId: 'd5', window: 2 })
        expect(before.output).toContain('messages 3–7 of 20')
        const start = await tools().read.execute({ conversationId: 'deploy', window: 1 })
        expect(start.output).toContain('messages 1–3 of 20')
    })

    test('refuses conversations outside the scope', async () => {
        for (const conversationId of ['current', 'incognito']) {
            expect((await tools().read.execute({ conversationId })).success).toBe(false)
        }
        expect((await tools('agent-1').read.execute({ conversationId: 'deploy' })).success).toBe(false)
        expect((await tools().read.execute({ conversationId: 'missing' })).success).toBe(false)
        expect((await tools().read.execute({ conversationId: 'deploy', messageId: 'd-tool' })).success).toBe(false)
    })
})
