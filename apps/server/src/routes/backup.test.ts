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
                details: { runs: 0, steps: 0, auxiliaryModelUsage: 1 },
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
})
