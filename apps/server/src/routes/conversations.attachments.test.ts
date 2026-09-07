import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb } from '../db/database.js'
import { materializeAudioArtifacts, materializeImageArtifacts } from '../core/artifacts/image-artifacts.js'
import { materializeFileAttachments } from '../core/artifacts/file-artifacts.js'
import { persistMessageFileAttachments } from '../core/artifacts/attachment-rag.js'
import { registerConversationRoutes } from './conversations.js'

describe('conversation message attachment resolution', () => {
    let directory = ''

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'cynosure-message-attachments-'))
        process.env.CYNOSURE_DATA_DIR = directory
    })

    afterEach(async () => {
        closeDb()
        delete process.env.CYNOSURE_DATA_DIR
        await rm(directory, { recursive: true, force: true })
    })

    test('forks persisted history and configuration through the selected message', async () => {
        const db = getDb()
        db.prepare(`INSERT INTO conversations (id, title, execution_config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
            .run('source', 'Original', '{"model":"selected-model"}', 1, 4)
        const insert = db.prepare('INSERT INTO messages (id, conversation_id, role, content, context_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        insert.run('user', 'source', 'user', 'Question', null, 1)
        insert.run('answer', 'source', 'assistant', 'Answer', 42, 2)
        insert.run('later', 'source', 'user', 'Later', 99, 2)
        const app = Fastify()
        await app.register(registerConversationRoutes, { prefix: '/api/chat' })
        try {
            const response = await app.inject({ method: 'POST', url: '/api/chat/conversations/source/fork', payload: { messageId: 'answer' } })
            expect(response.statusCode, response.body).toBe(200)
            const { id } = response.json()
            expect(db.prepare('SELECT content FROM messages WHERE conversation_id = ? ORDER BY created_at').all(id)).toEqual([{ content: 'Question' }, { content: 'Answer' }])
            expect(db.prepare('SELECT title, last_context_tokens, execution_config_json FROM conversations WHERE id = ?').get(id)).toEqual({ title: 'Original (fork)', last_context_tokens: 42, execution_config_json: '{"model":"selected-model"}' })
            expect(db.prepare('SELECT count(*) AS count FROM messages WHERE conversation_id = ?').get('source')).toEqual({ count: 3 })
        } finally {
            await app.close()
        }
    })

    test('returns provider-safe media and original files for an edited message', async () => {
        const now = Date.now()
        const db = getDb()
        db.prepare(
            `INSERT INTO conversations (id, title, origin, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
        ).run('conversation-1', 'Attachments', 'chat', now, now)

        const images = await materializeImageArtifacts(['data:image/png;base64,aW1hZ2U='], 'conversation-1')
        const audio = await materializeAudioArtifacts(['data:audio/wav;base64,YXVkaW8='], 'conversation-1')
        const files = await materializeFileAttachments([{ name: 'notes.txt', content: 'remember me' }], 'conversation-1')
        db.prepare(
            `INSERT INTO messages (id, conversation_id, role, content, image_urls_json, audio_urls_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            'message-1',
            'conversation-1',
            'user',
            'Use these.',
            JSON.stringify(images.map((item) => item.url)),
            JSON.stringify(audio.map((item) => item.url)),
            now,
        )
        persistMessageFileAttachments(db, 'message-1', 'conversation-1', files, now)

        const app = Fastify()
        await app.register(registerConversationRoutes, { prefix: '/api/chat' })
        const response = await app.inject({
            method: 'GET',
            url: '/api/chat/conversations/conversation-1/messages/message-1/attachments',
        })
        await app.close()

        expect(response.statusCode).toBe(200)
        const body = response.json() as {
            imageDataUrls: string[]
            audioDataUrls: string[]
            files: { name: string; content: string }[]
        }
        expect(body.imageDataUrls[0]).toMatch(/^data:image\/png;base64,/)
        expect(body.audioDataUrls[0]).toMatch(/^data:audio\/wav;base64,/)
        expect(body.files[0].name).toBe('notes.txt')
        expect(Buffer.from(body.files[0].content.split(',')[1], 'base64').toString('utf8')).toBe('remember me')
    })

    test('lists persisted document uploads with their conversation metadata', async () => {
        const now = Date.now()
        const db = getDb()
        db.prepare(
            `INSERT INTO agents (id, name, created_at, updated_at)
             VALUES (?, ?, ?, ?)`,
        ).run('agent-1', 'Researcher', now, now)
        db.prepare(
            `INSERT INTO conversations (id, title, agent_id, origin, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).run('conversation-1', 'Quarterly research', 'agent-1', 'chat', now, now)
        db.prepare(
            `INSERT INTO messages (id, conversation_id, role, content, created_at)
             VALUES (?, ?, ?, ?, ?)`,
        ).run('message-1', 'conversation-1', 'user', 'Review this.', now)
        const files = await materializeFileAttachments([{ name: 'briefing.pdf', content: 'report contents' }], 'conversation-1')
        persistMessageFileAttachments(db, 'message-1', 'conversation-1', files, now)

        const app = Fastify()
        await app.register(registerConversationRoutes, { prefix: '/api/chat' })
        const response = await app.inject({
            method: 'GET',
            url: '/api/chat/uploads?search=quarterly',
        })
        await app.close()

        expect(response.statusCode).toBe(200)
        expect(response.json()).toMatchObject({
            total: 1,
            items: [{
                name: 'briefing.pdf',
                ext: 'pdf',
                conversationId: 'conversation-1',
                conversationTitle: 'Quarterly research',
                agentName: 'Researcher',
            }],
        })
    })
})
