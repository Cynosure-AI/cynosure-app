import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb } from '../db/database.js'
import { registerActivityRoutes } from './activity.js'

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

    test('only includes generated assistant media, not uploads or tool-viewed media', async () => {
        const now = Date.now()
        const db = getDb()
        db.prepare(
            `INSERT INTO conversations (id, title, origin, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
        ).run('conversation-1', 'Organize disk files', 'chat', now, now)
        db.prepare(
            `INSERT INTO execution_steps (id, conversation_id, iteration, status, results_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
            'step-1',
            'conversation-1',
            1,
            'completed',
            JSON.stringify({ filesRead: ['/photos/existing-image.jpg', '/notes/existing.md'] }),
            now,
        )
        db.prepare(
            `INSERT INTO messages (id, conversation_id, role, content, image_urls_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
            'message-1',
            'conversation-1',
            'assistant',
            'Generated an image.',
            JSON.stringify(['https://example.com/generated.png']),
            now + 1,
        )
        db.prepare(
            `INSERT INTO messages (id, conversation_id, role, content, audio_urls_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
            'tool-message-1',
            'conversation-1',
            'tool',
            'Viewed existing audio.',
            JSON.stringify(['/api/files?path=%2Ftmp%2Fexisting.mp3']),
            now + 2,
        )
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
        db.prepare(
            `INSERT INTO messages (id, conversation_id, role, content, image_urls_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
            'user-message-1',
            'conversation-1',
            'user',
            'Use this upload.',
            JSON.stringify(['/api/files?path=%2Ftmp%2Fuploaded.png']),
            now + 3,
        )
        db.prepare(
            `INSERT INTO messages (id, conversation_id, role, content, image_urls_json, audio_urls_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            'assistant-message-2',
            'conversation-1',
            'assistant',
            'I inspected the supplied media.',
            JSON.stringify(['/api/files?path=%2Ftmp%2Fuploaded.png']),
            JSON.stringify(['/api/files?path=%2Ftmp%2Fexisting.mp3']),
            now + 4,
        )
        db.prepare(
            `INSERT INTO messages (id, conversation_id, role, content, audio_urls_json, generated_media, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            'generated-tool-message',
            'conversation-1',
            'tool',
            'Synthesized speech.',
            JSON.stringify(['/api/files?path=%2Ftmp%2Fspeech.wav']),
            1,
            now + 5,
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
        expect(body.items).toHaveLength(2)
        expect(body.items[0].sourceId).toBe('generated-tool-message')
        expect(body.items[0].artifacts).toEqual([
            expect.objectContaining({ label: 'speech.wav' }),
        ])
        expect(body.items[1].sourceId).toBe('message-1')
        expect(body.items[1].artifacts).toEqual([
            expect.objectContaining({ label: 'generated.png' }),
        ])
    })
})
