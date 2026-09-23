import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb } from '../db/database.js'
import { materializeAudioArtifacts, materializeImageArtifacts } from '../core/artifacts/image-artifacts.js'
import { materializeFileAttachments } from '../core/artifacts/file-artifacts.js'
import { persistMessageFileAttachments, reuseConversationAttachment } from '../core/artifacts/attachment-rag.js'
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
        db.prepare('INSERT INTO chat_events (conversation_id, execution_id, event_json, created_at) VALUES (?, ?, ?, ?)')
            .run('source', 'run-1', JSON.stringify({ type: 'transcript-item', item: {
                type: 'message', id: 'answer', role: 'assistant', content: [{ type: 'text', text: 'Answer' }], createdAt: 2,
            } }), 2)
        const app = Fastify()
        await app.register(registerConversationRoutes, { prefix: '/api/chat' })
        try {
            const response = await app.inject({ method: 'POST', url: '/api/chat/conversations/source/fork', payload: { messageId: 'answer' } })
            expect(response.statusCode, response.body).toBe(200)
            const { id } = response.json()
            expect(db.prepare('SELECT content FROM messages WHERE conversation_id = ? ORDER BY created_at').all(id)).toEqual([{ content: 'Question' }, { content: 'Answer' }])
            expect(db.prepare('SELECT title, last_context_tokens, execution_config_json FROM conversations WHERE id = ?').get(id)).toEqual({ title: 'Original (fork)', last_context_tokens: 42, execution_config_json: '{"model":"selected-model"}' })
            expect(db.prepare('SELECT count(*) AS count FROM messages WHERE conversation_id = ?').get('source')).toEqual({ count: 3 })
            const clonedEvent = db.prepare('SELECT event_json FROM chat_events WHERE conversation_id = ?').get(id) as { event_json: string }
            const forkedAnswer = db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant'").get(id) as { id: string }
            expect(JSON.parse(clonedEvent.event_json).item.id).toBe(forkedAnswer.id)
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
            `INSERT INTO messages (id, conversation_id, role, content, content_blocks_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
            'message-1',
            'conversation-1',
            'user',
            'Use these.',
            JSON.stringify([
                { type: 'text', text: 'Use these.' },
                ...images.map((item) => ({ type: 'image', artifactId: item.url, url: item.url })),
                ...audio.map((item) => ({ type: 'audio', artifactId: item.url, url: item.url })),
            ]),
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

    test('returns browser links for persisted message attachments', async () => {
        const now = Date.now()
        const db = getDb()
        db.prepare(
            `INSERT INTO conversations (id, title, origin, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
        ).run('conversation-1', 'Attachments', 'chat', now, now)
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
            url: '/api/chat/conversations/conversation-1/messages',
        })
        await app.close()

        expect(response.statusCode).toBe(200)
        expect(response.json().messages[0].content).toContainEqual(expect.objectContaining({
            type: 'file', name: 'briefing.pdf', url: expect.stringContaining('&name=briefing.pdf'),
        }))
    })

    test('returns a message snapshot cursor and explicit execution step order', async () => {
        const db = getDb()
        db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('c1', 'Chat', 1, 1)
        db.prepare('INSERT INTO messages (id, conversation_id, role, content, content_blocks_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run('m1', 'c1', 'user', 'Hello', '[{"type":"text","text":"Hello"}]', 1)
        const insertEvent = db.prepare('INSERT INTO chat_events (conversation_id, execution_id, event_json, created_at) VALUES (?, ?, ?, ?)')
        const messageEvent = insertEvent.run('c1', 'e1', JSON.stringify({ type: 'transcript-item', item: { type: 'message', id: 'm1' } }), 2)
        const stepEvent = insertEvent.run('c1', 'e1', JSON.stringify({ type: 'execution-step', taskId: 't1', iteration: 1, status: 'executing' }), 3)
        const app = Fastify()
        await app.register(registerConversationRoutes, { prefix: '/api/chat' })
        try {
            const messages = await app.inject({ method: 'GET', url: '/api/chat/conversations/c1/messages' })
            expect(messages.statusCode).toBe(200)
            expect(messages.json().latestEventSequence).toBe(Number(messageEvent.lastInsertRowid))
            expect(messages.json().messages[0]).toMatchObject({ sequence: Number(messageEvent.lastInsertRowid), content: [{ type: 'text', text: 'Hello' }] })
            const events = db.prepare('SELECT sequence FROM chat_events WHERE conversation_id = ? ORDER BY sequence').all('c1') as { sequence: number }[]
            expect(events.at(-1)?.sequence).toBe(Number(stepEvent.lastInsertRowid))
        } finally {
            await app.close()
        }
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
                status: 'ready',
                staged: false,
            }],
        })
    })

    test('resolves selected uploads into reusable attachment payloads', async () => {
        const now = Date.now()
        const db = getDb()
        db.prepare(
            `INSERT INTO conversations (id, title, origin, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
        ).run('conversation-1', 'Source chat', 'chat', now, now)
        db.prepare(
            `INSERT INTO messages (id, conversation_id, role, content, created_at)
             VALUES (?, ?, ?, ?, ?)`,
        ).run('message-1', 'conversation-1', 'user', 'Keep this.', now)
        const files = await materializeFileAttachments([
            { name: 'first.txt', content: 'first contents' },
            { name: 'second.txt', content: 'second contents' },
        ], 'conversation-1')
        persistMessageFileAttachments(db, 'message-1', 'conversation-1', files, now)

        const app = Fastify()
        await app.register(registerConversationRoutes, { prefix: '/api/chat' })
        const response = await app.inject({
            method: 'POST',
            url: '/api/chat/uploads/resolve',
            payload: { ids: [files[1].id, files[0].id] },
        })
        await app.close()

        expect(response.statusCode, response.body).toBe(200)
        const resolved = response.json().files as { id: string; name: string; existingAttachmentId: string }[]
        expect(resolved.map((file) => file.name)).toEqual(['second.txt', 'first.txt'])
        expect(resolved.map((file) => file.existingAttachmentId)).toEqual([files[1].id, files[0].id])
    })

    test('reuses one canonical asset across message attachment references', async () => {
        const db = getDb()
        const now = Date.now()
        db.prepare(`INSERT INTO conversations (id, title, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run('source', 'Source', 'chat', now, now)
        db.prepare(`INSERT INTO conversations (id, title, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run('target', 'Target', 'chat', now, now)
        db.prepare(`INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', '', ?)`).run('source-message', 'source', now)
        db.prepare(`INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', '', ?)`).run('target-message', 'target', now)
        const [source] = await materializeFileAttachments([{ name: 'shared.txt', content: 'one canonical copy' }], 'source')
        persistMessageFileAttachments(db, 'source-message', 'source', [source], now)

        const reused = await reuseConversationAttachment('target', source.id)
        expect(reused).not.toBeNull()
        persistMessageFileAttachments(db, 'target-message', 'target', [reused!], now)

        expect(db.prepare('SELECT COUNT(*) AS count FROM attachment_assets').get()).toEqual({ count: 1 })
        expect(db.prepare('SELECT DISTINCT asset_id FROM message_attachments').all()).toEqual([{ asset_id: source.id }])
        expect(reused?.originalPath).toBe(source.originalPath)
        expect(reused?.textPath).toBe(source.textPath)
    })

    test('resolves generated artifacts into chat context payloads', async () => {
        const images = await materializeImageArtifacts(['data:image/png;base64,aW1hZ2U='], 'source-conversation')
        const audio = await materializeAudioArtifacts(['data:audio/wav;base64,YXVkaW8='], 'source-conversation')
        const files = await materializeFileAttachments([{ name: 'report.md', content: '# Findings' }], 'source-conversation')
        const app = Fastify()
        await app.register(registerConversationRoutes, { prefix: '/api/chat' })
        const response = await app.inject({
            method: 'POST',
            url: '/api/chat/artifacts/resolve',
            payload: {
                artifacts: [
                    { id: 'image', href: images[0].url, label: 'concept.png', kind: 'image' },
                    { id: 'audio', href: audio[0].url, label: 'narration.wav', kind: 'audio' },
                    { id: 'file', href: `/api/files?path=${encodeURIComponent(files[0].originalPath)}`, label: 'report.md', kind: 'file' },
                ],
            },
        })
        await app.close()

        expect(response.statusCode, response.body).toBe(200)
        const resolved = response.json() as {
            images: { id: string; name: string; url: string }[]
            audio: { id: string; name: string; url: string }[]
            files: { id: string; name: string; content: string }[]
        }
        expect(resolved.images[0]).toMatchObject({ id: 'image', name: 'concept.png', url: expect.stringMatching(/^data:image\/png;base64,/) })
        expect(resolved.audio[0]).toMatchObject({ id: 'audio', name: 'narration.wav', url: expect.stringMatching(/^data:audio\/wav;base64,/) })
        expect(Buffer.from(resolved.files[0].content.split(',')[1], 'base64').toString('utf8')).toBe('# Findings')
    })

    test('rejects video artifacts because chat has no video input contract', async () => {
        const app = Fastify()
        await app.register(registerConversationRoutes, { prefix: '/api/chat' })
        const response = await app.inject({
            method: 'POST',
            url: '/api/chat/artifacts/resolve',
            payload: { artifacts: [{ id: 'video', href: 'https://example.com/video.mp4', label: 'video.mp4', kind: 'video' }] },
        })
        await app.close()

        expect(response.statusCode).toBe(400)
        expect(response.json()).toEqual({ error: 'Video artifacts cannot currently be used as chat context' })
    })
})
