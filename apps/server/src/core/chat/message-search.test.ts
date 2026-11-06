import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb } from '../../db/database.js'
import { registerConversationRoutes } from '../../routes/conversations.js'
import { buildMessageSearchQuery, listRecentConversations, searchMessages, SNIPPET_MATCH_END, SNIPPET_MATCH_START } from './message-search.js'

describe('buildMessageSearchQuery', () => {
    test('quotes each word as a prefix term so operators are plain text', () => {
        expect(buildMessageSearchQuery('docker OR NOT compose*')).toBe('"docker"* "OR"* "NOT"* "compose*"*')
    })

    test('keeps double-quoted parts as exact phrases', () => {
        expect(buildMessageSearchQuery('"compose up" docker')).toBe('"compose up" "docker"*')
    })

    test('joins terms with OR when any term may match', () => {
        expect(buildMessageSearchQuery('docker "compose up"', 'any')).toBe('"docker"* OR "compose up"')
    })

    test('drops input without letters or digits', () => {
        expect(buildMessageSearchQuery(' - ( ) " " ')).toBeNull()
        expect(buildMessageSearchQuery('a"b')).toBe('"ab"*')
    })
})

describe('message search', () => {
    let directory = ''

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'cynosure-message-search-'))
        process.env.CYNOSURE_DATA_DIR = directory
    })

    afterEach(async () => {
        closeDb()
        delete process.env.CYNOSURE_DATA_DIR
        await rm(directory, { recursive: true, force: true })
    })

    function seed() {
        const db = getDb()
        const conversation = db.prepare('INSERT INTO conversations (id, title, temporary, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        conversation.run('c1', 'Deploying', 0, 1, 10)
        conversation.run('c2', 'Other', 0, 1, 20)
        conversation.run('incognito', 'Secret', 1, 1, 30)
        const message = db.prepare('INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        message.run('m1', 'c1', 'user', 'How do I deploy the Datenbank server with Docker?', 1)
        message.run('m2', 'c1', 'assistant', 'Run docker compose up -d in the project folder. Café notes.', 2)
        message.run('m3', 'c1', 'tool', 'kubernetes tool output', 3)
        message.run('m4', 'c2', 'user', 'Should I use docker here too?', 4)
        message.run('m5', 'incognito', 'user', 'docker incognito', 5)
        return db
    }

    test('returns the best message per conversation with highlighted snippets', () => {
        const db = seed()
        const hits = searchMessages(db, 'dock')
        expect(hits.map((hit) => hit.conversationId).sort()).toEqual(['c1', 'c2'])
        const c1 = hits.find((hit) => hit.conversationId === 'c1')!
        expect(c1).toMatchObject({ title: 'Deploying', matchCount: 2 })
        expect(c1.snippet.toLowerCase()).toContain(`${SNIPPET_MATCH_START}docker${SNIPPET_MATCH_END}`)
    })

    test('requires every term, folds diacritics, and matches phrases exactly', () => {
        const db = seed()
        expect(searchMessages(db, 'docker datenbank').map((hit) => hit.messageId)).toEqual(['m1'])
        expect(searchMessages(db, 'cafe').map((hit) => hit.messageId)).toEqual(['m2'])
        expect(searchMessages(db, '"compose up"').map((hit) => hit.messageId)).toEqual(['m2'])
        expect(searchMessages(db, '"up compose"')).toEqual([])
    })

    test('skips tool output and incognito chats', () => {
        const db = seed()
        expect(searchMessages(db, 'kubernetes')).toEqual([])
        expect(searchMessages(db, 'incognito')).toEqual([])
    })

    test('keeps the index in sync with edits, role changes, and deletes', () => {
        const db = seed()
        db.prepare("UPDATE messages SET content = 'Switched to podman' WHERE id = 'm4'").run()
        expect(searchMessages(db, 'podman').map((hit) => hit.messageId)).toEqual(['m4'])
        expect(searchMessages(db, 'docker').map((hit) => hit.conversationId)).toEqual(['c1'])

        db.prepare("UPDATE messages SET role = 'system' WHERE id = 'm4'").run()
        expect(searchMessages(db, 'podman')).toEqual([])

        db.prepare("DELETE FROM conversations WHERE id = 'c1'").run()
        expect(searchMessages(db, 'docker')).toEqual([])
        const counts = db.prepare('SELECT (SELECT COUNT(*) FROM message_search) AS indexed, (SELECT COUNT(*) FROM message_search_rowids) AS keys').get()
        expect(counts).toEqual({ indexed: 1, keys: 1 })
    })

    test('filters by time, agent and excluded conversation', () => {
        const db = seed()
        db.prepare("UPDATE conversations SET agent_id = 'agent-1' WHERE id = 'c2'").run()
        expect(searchMessages(db, 'docker', 20, { since: 3 }).map((hit) => hit.messageId)).toEqual(['m4'])
        expect(searchMessages(db, 'docker', 20, { until: 3 }).map((hit) => hit.conversationId)).toEqual(['c1'])
        expect(searchMessages(db, 'docker', 20, { agentId: 'agent-1' }).map((hit) => hit.conversationId)).toEqual(['c2'])
        expect(searchMessages(db, 'docker', 20, { excludeConversationId: 'c1' }).map((hit) => hit.conversationId)).toEqual(['c2'])
    })

    test('matches any term on request', () => {
        const db = seed()
        expect(searchMessages(db, 'podman datenbank')).toEqual([])
        expect(searchMessages(db, 'podman datenbank', 20, { match: 'any' }).map((hit) => hit.messageId)).toEqual(['m1'])
    })

    test('lists recent conversations with their first user message, without incognito chats', () => {
        const db = seed()
        const hits = listRecentConversations(db)
        expect(hits.map((hit) => [hit.conversationId, hit.messageId, hit.matchCount])).toEqual([['c2', 'm4', 1], ['c1', 'm1', 2]])
        expect(hits[1].snippet).toBe('How do I deploy the Datenbank server with Docker?')
        expect(listRecentConversations(db, 20, { since: 2 }).map((hit) => [hit.conversationId, hit.messageId])).toEqual([['c2', 'm4'], ['c1', 'm2']])
        expect(listRecentConversations(db, 20, { excludeConversationId: 'c2' }).map((hit) => hit.conversationId)).toEqual(['c1'])
    })

    test('serves results over the API and ignores queries shorter than two characters', async () => {
        seed()
        const app = Fastify()
        await app.register(registerConversationRoutes, { prefix: '/api/chat' })
        try {
            const short = await app.inject({ method: 'GET', url: '/api/chat/message-search?q=d' })
            expect(short.json()).toEqual({ items: [] })
            const response = await app.inject({ method: 'GET', url: `/api/chat/message-search?q=${encodeURIComponent('docker datenbank')}` })
            expect(response.statusCode, response.body).toBe(200)
            expect(response.json().items).toMatchObject([{ conversationId: 'c1', messageId: 'm1', role: 'user' }])
        } finally {
            await app.close()
        }
    })
})
