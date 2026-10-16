import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb } from '../db/database.js'
import { purgeTemporaryConversations, registerConversationRoutes } from './conversations.js'
import { createCronJob, getWaitJobsForConversation } from '../core/triggers/cron-scheduler.js'

describe('incognito conversations', () => {
    let directory = ''

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'cynosure-temporary-chats-'))
        process.env.CYNOSURE_DATA_DIR = directory
    })

    afterEach(async () => {
        closeDb()
        delete process.env.CYNOSURE_DATA_DIR
        await rm(directory, { recursive: true, force: true })
    })

    async function withApp(run: (app: ReturnType<typeof Fastify>) => Promise<void>): Promise<void> {
        const app = Fastify()
        await app.register(registerConversationRoutes, { prefix: '/api/chat' })
        try {
            await run(app)
        } finally {
            await app.close()
        }
    }

    function listedIds(body: Array<{ id: string }>): string[] {
        return body.map((row) => row.id)
    }

    test('stay out of every list until saved', async () => {
        const db = getDb()
        db.prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p', 'Project', 1, 1)").run()
        await withApp(async (app) => {
            const created = await app.inject({ method: 'POST', url: '/api/chat/conversations', payload: { temporary: true, projectId: 'p' } })
            expect(created.statusCode, created.body).toBe(200)
            const { id, temporary } = created.json()
            expect(temporary).toBe(true)

            const all = await app.inject({ method: 'GET', url: '/api/chat/conversations' })
            expect(listedIds(all.json())).not.toContain(id)
            const project = await app.inject({ method: 'GET', url: '/api/chat/conversations?projectId=p' })
            expect(listedIds(project.json())).not.toContain(id)
            const page = await app.inject({ method: 'GET', url: '/api/chat/conversations?limit=10&sort=sidebar' })
            expect(page.json().total).toBe(0)

            const messages = await app.inject({ method: 'GET', url: `/api/chat/conversations/${id}/messages` })
            expect(messages.json().temporary).toBe(true)

            const saved = await app.inject({ method: 'POST', url: `/api/chat/conversations/${id}/save` })
            expect(saved.statusCode, saved.body).toBe(200)
            const afterSave = await app.inject({ method: 'GET', url: '/api/chat/conversations' })
            expect(listedIds(afterSave.json())).toContain(id)
        })
    })

    test('discard deletes an incognito chat and leaves a saved one alone', async () => {
        const db = getDb()
        const insert = db.prepare('INSERT INTO conversations (id, title, temporary, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
        insert.run('incognito', 'Secret', 1)
        insert.run('saved', 'Kept', 0)
        db.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m1', 'incognito', 'user', 'hi', 1)").run()

        await withApp(async (app) => {
            const discarded = await app.inject({ method: 'POST', url: '/api/chat/conversations/incognito/discard' })
            expect(discarded.json()).toEqual({ success: true, discarded: true })
            const kept = await app.inject({ method: 'POST', url: '/api/chat/conversations/saved/discard' })
            expect(kept.json()).toEqual({ success: true, discarded: false })
        })

        expect(db.prepare('SELECT id FROM conversations ORDER BY id').all()).toEqual([{ id: 'saved' }])
        expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 })
    })

    test('discard removes waits that would resume the incognito chat', async () => {
        const db = getDb()
        db.prepare("INSERT INTO conversations (id, title, temporary, created_at, updated_at) VALUES ('incognito', 'Secret', 1, 1, 1)").run()
        createCronJob({ agentId: '', schedule: '0 0 1 1 *', prompt: 'check back', oneOff: true, conversationId: 'incognito' })
        expect(getWaitJobsForConversation('incognito')).toHaveLength(1)

        await withApp(async (app) => {
            await app.inject({ method: 'POST', url: '/api/chat/conversations/incognito/discard' })
        })

        expect(getWaitJobsForConversation('incognito')).toEqual([])
    })

    test('the startup purge removes only incognito chats', async () => {
        const db = getDb()
        const insert = db.prepare('INSERT INTO conversations (id, title, temporary, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
        insert.run('abandoned', 'Secret', 1)
        insert.run('saved', 'Kept', 0)

        await purgeTemporaryConversations()

        expect(db.prepare('SELECT id FROM conversations').all()).toEqual([{ id: 'saved' }])
    })
})
