import Fastify from 'fastify'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb } from '../db/database.js'
import { registerBackupRoutes } from './backup.js'

describe('usage backup', () => {
    let directory = ''

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'cynosure-backup-'))
        process.env.CYNOSURE_DATA_DIR = directory
    })

    afterEach(async () => {
        closeDb()
        delete process.env.CYNOSURE_DATA_DIR
        await rm(directory, { recursive: true, force: true })
    })

    test('exports, reports, and restores auxiliary model usage', async () => {
        const db = getDb()
        db.prepare(`
            INSERT INTO auxiliary_model_usage
                (id, kind, provider, model, input_tokens, output_tokens, request_count, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run('usage-1', 'dreaming', 'openai', 'gpt-test', 120, 45, 2, 123456)

        const app = Fastify()
        await app.register(async registeredApp => registerBackupRoutes(registeredApp), { prefix: '/api/backup' })

        try {
            const summaryResponse = await app.inject({ method: 'GET', url: '/api/backup/summary' })
            expect(summaryResponse.statusCode).toBe(200)
            expect(summaryResponse.json().modules.usage).toEqual({
                count: 1,
                details: { runs: 0, auxiliaryModelUsage: 1, chatMessages: 0 },
            })

            const exportResponse = await app.inject({
                method: 'GET',
                url: '/api/backup/export?modules=usage',
            })
            expect(exportResponse.statusCode).toBe(200)

            const zip = new AdmZip(exportResponse.rawPayload)
            expect(zip.getEntry('manifest.json')).not.toBeNull()
            expect(zip.getEntry('usage/auxiliary_model_usage.json')).not.toBeNull()
            expect(JSON.parse(zip.readAsText('manifest.json')).modules.usage.count).toBe(1)
            expect(JSON.parse(zip.readAsText('usage/auxiliary_model_usage.json'))).toEqual([
                expect.objectContaining({
                    id: 'usage-1',
                    kind: 'dreaming',
                    provider: 'openai',
                    model: 'gpt-test',
                    input_tokens: 120,
                    output_tokens: 45,
                    request_count: 2,
                    created_at: 123456,
                }),
            ])

            db.prepare('DELETE FROM auxiliary_model_usage').run()

            const boundary = '----cynosure-backup-test'
            const multipartBody = Buffer.concat([
                Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="backup.zip"\r\nContent-Type: application/zip\r\n\r\n`),
                exportResponse.rawPayload,
                Buffer.from(`\r\n--${boundary}--\r\n`),
            ])
            const importResponse = await app.inject({
                method: 'POST',
                url: '/api/backup/import',
                headers: {
                    'content-type': `multipart/form-data; boundary=${boundary}`,
                    'content-length': String(multipartBody.length),
                },
                payload: multipartBody,
            })

            expect(importResponse.statusCode, importResponse.body).toBe(200)
            expect(importResponse.json().results.usage).toEqual({ restored: 1, errors: [] })
            expect(db.prepare('SELECT * FROM auxiliary_model_usage WHERE id = ?').get('usage-1')).toEqual({
                id: 'usage-1',
                kind: 'dreaming',
                provider: 'openai',
                model: 'gpt-test',
                input_tokens: 120,
                output_tokens: 45,
                request_count: 2,
                created_at: 123456,
            })
        } finally {
            await app.close()
        }
    })

    test('round-trips canonical content and ordered chat events', async () => {
        const db = getDb()
        db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('c1', 'Chat', 1, 1)
        db.prepare('INSERT INTO messages (id, conversation_id, role, content, content_blocks_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run('m1', 'c1', 'user', 'Hello', '[{"type":"text","text":"Hello"}]', 1)
        db.prepare('INSERT INTO chat_events (conversation_id, execution_id, event_json, created_at) VALUES (?, ?, ?, ?)')
            .run('c1', 'e1', JSON.stringify({ type: 'transcript-item', item: { type: 'message', id: 'm1' } }), 2)
        const app = Fastify()
        await app.register(async registeredApp => registerBackupRoutes(registeredApp), { prefix: '/api/backup' })
        try {
            const exported = await app.inject({ method: 'GET', url: '/api/backup/export?modules=conversations' })
            expect(exported.statusCode).toBe(200)
            const zip = new AdmZip(exported.rawPayload)
            expect(JSON.parse(zip.readAsText('conversations/chat_events.json'))).toHaveLength(1)
            expect(JSON.parse(zip.readAsText('conversations/messages.json'))[0].content_blocks_json).toBe('[{"type":"text","text":"Hello"}]')
            db.prepare('DELETE FROM chat_events').run()
            db.prepare('DELETE FROM messages').run()
            db.prepare('DELETE FROM conversations').run()
            const boundary = '----cynosure-chat-backup-test'
            const payload = Buffer.concat([
                Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="backup.zip"\r\nContent-Type: application/zip\r\n\r\n`),
                exported.rawPayload,
                Buffer.from(`\r\n--${boundary}--\r\n`),
            ])
            const imported = await app.inject({ method: 'POST', url: '/api/backup/import',
                headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(payload.length) },
                payload })
            expect(imported.statusCode, imported.body).toBe(200)
            expect((db.prepare('SELECT content_blocks_json FROM messages WHERE id = ?').get('m1') as { content_blocks_json: string }).content_blocks_json)
                .toBe('[{"type":"text","text":"Hello"}]')
            expect(db.prepare('SELECT execution_id FROM chat_events WHERE conversation_id = ?').all('c1')).toEqual([{ execution_id: 'e1' }])
            expect(db.prepare('SELECT message_id FROM dream_message_events WHERE message_id = ?').all('m1')).toEqual([])
        } finally {
            await app.close()
        }
    })

    test('replaces existing memory documents and revisions during restore', async () => {
        const db = getDb()
        db.prepare(`INSERT INTO memory_documents
            (document_id, document_ref, category_id, file_name, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`)
            .run('doc-1', 'memory://doc-1', 'uncategorized', 'note.md', 1, 1)
        db.prepare(`INSERT INTO memory_document_revisions
            (id, document_id, revision_number, content_hash, content, source, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run('revision-1', 'doc-1', 1, 'hash', 'Remember this', 'user', 1)
        const app = Fastify()
        await app.register(async registeredApp => registerBackupRoutes(registeredApp), { prefix: '/api/backup' })
        try {
            const exported = await app.inject({ method: 'GET', url: '/api/backup/export?modules=memory' })
            expect(exported.statusCode).toBe(200)
            const exportedZip = new AdmZip(exported.rawPayload)
            const memoryMetadata = JSON.parse(exportedZip.readAsText('memory/categories.json'))
            memoryMetadata.revisions[0].source = 'legacy-source'
            const zip = new AdmZip()
            for (const entry of exportedZip.getEntries()) {
                if (entry.isDirectory) continue
                zip.addFile(entry.entryName, entry.entryName === 'memory/categories.json'
                    ? Buffer.from(JSON.stringify(memoryMetadata)) : entry.getData())
            }
            const boundary = '----cynosure-memory-backup-test'
            const payload = Buffer.concat([
                Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="backup.zip"\r\nContent-Type: application/zip\r\n\r\n`),
                zip.toBuffer(),
                Buffer.from(`\r\n--${boundary}--\r\n`),
            ])
            const imported = await app.inject({ method: 'POST', url: '/api/backup/import',
                headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(payload.length) },
                payload })
            expect(imported.statusCode, imported.body).toBe(200)
            expect(imported.json().results.memory.errors).toEqual([])
            expect(db.prepare('SELECT content, source FROM memory_document_revisions WHERE id = ?').get('revision-1'))
                .toEqual({ content: 'Remember this', source: 'restore' })
        } finally {
            await app.close()
        }
    })
})
