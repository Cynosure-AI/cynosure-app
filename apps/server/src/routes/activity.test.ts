import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb } from '../db/database.js'
import { registerActivityRoutes } from './activity.js'
import { registerActiveChatExecution, unregisterActiveChatExecution } from '../core/chat/active-executions.js'
import { messageContentJson } from '../core/chat/transcript.js'
import type Database from 'better-sqlite3'

function insertMediaMessage(db: Database.Database, id: string, conversationId: string, role: string,
    content: string, createdAt: number, images: string[] = [], audio: string[] = [], generatedMedia = 0): void {
    db.prepare(`INSERT INTO messages (id, conversation_id, role, content, content_blocks_json, generated_media, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, conversationId, role, content,
        messageContentJson({ id, content, imageDataUrls: images, audioDataUrls: audio }), generatedMedia, createdAt)
}

describe('activity artifact discovery', () => {
    let directory = ''

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'cynosure-activity-'))
        process.env.CYNOSURE_DATA_DIR = directory
    })

    afterEach(async () => {
        closeDb()
        delete process.env.CYNOSURE_DATA_DIR
        await rm(directory, { recursive: true, force: true })
    })

    test('includes completed tool embedding jobs in activity history', async () => {
        const now = Date.now()
        getDb().prepare(`INSERT INTO memory_index_jobs (id, kind, category_id, file_name, status, progress_current, progress_total, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run('warmup', 'tool-embeddings', 'tool-registry', 'Tool capabilities', 'completed', 12, 12, now, now)
        const app = Fastify()
        await app.register(registerActivityRoutes, { prefix: '/api/activity' })
        try {
            const response = await app.inject({ method: 'GET', url: '/api/activity' })
            expect(response.statusCode).toBe(200)
            expect(response.json().items).toEqual(expect.arrayContaining([
                expect.objectContaining({ title: 'Indexed tool capabilities', description: '12/12 embeddings', status: 'completed', sourceLabel: 'Tool indexing' }),
            ]))
        } finally {
            await app.close()
        }
    })

    test('only includes generated assistant media, not uploads or tool-viewed media', async () => {
        const now = Date.now()
        const db = getDb()
        db.prepare(
            `INSERT INTO conversations (id, title, origin, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
        ).run('conversation-1', 'Organize disk files', 'chat', now, now)
        insertMediaMessage(db, 'message-1', 'conversation-1', 'assistant', 'Generated an image.', now + 1,
            ['https://example.com/generated.png'])
        insertMediaMessage(db, 'tool-message-1', 'conversation-1', 'tool', 'Viewed existing audio.', now + 2,
            [], ['/api/files?path=%2Ftmp%2Fexisting.mp3'])
        db.prepare(
            `INSERT INTO messages (id, conversation_id, role, content, created_at)
             VALUES (?, ?, ?, ?, ?)`,
        ).run(
            'assistant-view-intent',
            'conversation-1',
            'assistant',
            'I will inspect /tmp/existing-image.jpg now.',
            now + 2,
        )
        insertMediaMessage(db, 'user-message-1', 'conversation-1', 'user', 'Use this upload.', now + 3,
            ['/api/files?path=%2Ftmp%2Fuploaded.png'])
        insertMediaMessage(db, 'assistant-message-2', 'conversation-1', 'assistant', 'I inspected the supplied media.', now + 4,
            ['/api/files?path=%2Ftmp%2Fuploaded.png'], ['/api/files?path=%2Ftmp%2Fexisting.mp3'])
        insertMediaMessage(db, 'generated-tool-message', 'conversation-1', 'tool', 'Synthesized speech.', now + 5,
            [], ['/api/files?path=%2Ftmp%2Fspeech.wav'], 1)
        db.prepare(
            `INSERT INTO messages (id, conversation_id, role, content, tool_call_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
            'created-document-tool-message',
            'conversation-1',
            'tool',
            'Created DOCX document: /tmp/project-estimate.docx',
            'create-docx-call',
            now + 6,
        )
        db.prepare(
            `INSERT INTO messages (id, conversation_id, role, content, tool_call_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
            'parsed-document-tool-message',
            'conversation-1',
            'tool',
            'Parsed DOCX document: /tmp/source-material.docx',
            'parse-docx-call',
            now + 7,
        )

        const app = Fastify()
        await app.register(registerActivityRoutes, { prefix: '/api/activity' })
        const response = await app.inject({
            method: 'GET',
            url: '/api/activity?types=artifact',
        })
        await app.close()

        expect(response.statusCode).toBe(200)
        const body = response.json() as { items: { sourceId?: string; artifacts?: { label: string }[] }[] }
        expect(body.items).toHaveLength(3)
        expect(body.items[0].sourceId).toBe('created-document-tool-message')
        expect(body.items[0].artifacts).toEqual([
            expect.objectContaining({ label: 'project-estimate.docx' }),
        ])
        expect(body.items[1].sourceId).toBe('generated-tool-message')
        expect(body.items[1].artifacts).toEqual([
            expect.objectContaining({ label: 'speech.wav' }),
        ])
        expect(body.items[2].sourceId).toBe('message-1')
        expect(body.items[2].artifacts).toEqual([
            expect.objectContaining({ label: 'generated.png' }),
        ])
    })

    test('keeps older artifacts discoverable and paginated as ordinary messages accumulate', async () => {
        const db = getDb()
        const now = Date.now()
        db.prepare(`INSERT INTO conversations (id, title, origin, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)`).run('history', 'Artifact history', 'chat', now, now)
        const insert = db.prepare(`INSERT INTO messages
            (id, conversation_id, role, content, content_blocks_json, created_at)
            VALUES (?, 'history', 'assistant', ?, ?, ?)`)
        db.transaction(() => {
            for (let index = 0; index < 65; index++) {
                insert.run(`artifact-${index}`, 'Generated an image.',
                    messageContentJson({ id: `artifact-${index}`, content: 'Generated an image.',
                        imageDataUrls: [`https://example.com/generated-${index}.png`] }), now + index)
            }
        })()
        const app = Fastify()
        await app.register(registerActivityRoutes, { prefix: '/api/activity' })
        try {
            const url = '/api/activity?types=artifact&limit=60'
            const before = (await app.inject({ method: 'GET', url })).json()
            expect(before.items).toHaveLength(60)
            expect(before.hasMore).toBe(true)

            db.transaction(() => {
                for (let index = 0; index < 250; index++) {
                    insert.run(`reply-${index}`, 'An ordinary reply without artifacts.', null, now + 100 + index)
                }
            })()
            const after = (await app.inject({ method: 'GET', url })).json()
            expect(after).toEqual(before)
            expect(after.total).toBe(65)
            const lastPage = (await app.inject({ method: 'GET', url: `${url}&offset=60` })).json()
            expect(lastPage.items).toHaveLength(5)
            expect(lastPage.hasMore).toBe(false)
            expect(lastPage.items.map((item: { sourceId: string }) => item.sourceId))
                .toEqual(['artifact-4', 'artifact-3', 'artifact-2', 'artifact-1', 'artifact-0'])

            const search = (await app.inject({ method: 'GET', url: `${url}&search=generated-0.png` })).json()
            expect(search.items).toHaveLength(1)
            expect(search.items[0].sourceId).toBe('artifact-0')
        } finally {
            await app.close()
        }
    })

    test('stops active server work through one endpoint', async () => {
        const controller = new AbortController()
        registerActiveChatExecution({
            id: 'stop-all-chat',
            conversationId: 'stop-all-conversation',
            agentId: null,
            model: null,
            startedAt: Date.now(),
        }, controller)

        const app = Fastify()
        await app.register(registerActivityRoutes, { prefix: '/api/activity' })
        const response = await app.inject({ method: 'POST', url: '/api/activity/stop-all' })
        await app.close()
        unregisterActiveChatExecution('stop-all-chat')

        expect(response.statusCode).toBe(200)
        expect(response.json()).toMatchObject({
            success: true,
            total: 1,
            counts: { chats: 1 },
        })
        expect(controller.signal.aborted).toBe(true)
    })
})
