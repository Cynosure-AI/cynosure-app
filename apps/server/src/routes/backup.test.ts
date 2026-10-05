import Fastify from 'fastify'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb } from '../db/database.js'
import { getAppDataDir, getDefaultMemoryFolderDir } from '../core/data-dir.js'
import { stopAllMemoryFolderWatchers } from '../core/memory/memory-folder-watcher.js'
import { registerBackupRoutes } from './backup.js'

describe('usage backup', () => {
    let directory = ''

    beforeEach(async () => {
        closeDb()
        directory = await mkdtemp(join(tmpdir(), 'cynosure-backup-'))
        process.env.CYNOSURE_DATA_DIR = directory
    })

    afterEach(async () => {
        // Memory restores start folder watchers; stop them before the data dir goes away.
        await stopAllMemoryFolderWatchers()
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
        const mediaDir = join(getAppDataDir(), 'artifacts', 'conversations', 'c1', 'images')
        const assetDir = join(getAppDataDir(), 'artifacts', 'attachment-assets')
        mkdirSync(mediaDir, { recursive: true })
        mkdirSync(assetDir, { recursive: true })
        const imagePath = join(mediaDir, 'picture.png')
        const originalPath = join(assetDir, 'document.txt')
        const textPath = join(assetDir, 'document.txt.parsed.md')
        writeFileSync(imagePath, 'image bytes')
        writeFileSync(originalPath, 'original document')
        writeFileSync(textPath, '')
        db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('c1', 'Chat', 1, 1)
        db.prepare('INSERT INTO messages (id, conversation_id, role, content, content_blocks_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run('m1', 'c1', 'user', 'Hello', JSON.stringify([{ type: 'image', artifactId: 'image', url: `/api/files?path=${encodeURIComponent(imagePath)}` }]), 1)
        db.prepare(`INSERT INTO attachment_assets (id, name, original_path, text_path, size_bytes, text_bytes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run('asset1', 'document.txt', originalPath, textPath, 17, 0, 1)
        db.prepare(`INSERT INTO message_attachments
            (id, message_id, conversation_id, kind, name, original_path, text_path, size_bytes, text_bytes, asset_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run('attachment1', 'm1', 'c1', 'file', 'document.txt', originalPath, textPath, 17, 0, 'asset1', 1)
        db.prepare('INSERT INTO chat_events (conversation_id, execution_id, event_json, created_at) VALUES (?, ?, ?, ?)')
            .run('c1', 'e1', JSON.stringify({ type: 'transcript-item', item: { type: 'message', id: 'm1' } }), 2)
        const app = Fastify()
        await app.register(async registeredApp => registerBackupRoutes(registeredApp), { prefix: '/api/backup' })
        try {
            const exported = await app.inject({ method: 'GET', url: '/api/backup/export?modules=conversations' })
            expect(exported.statusCode).toBe(200)
            const zip = new AdmZip(exported.rawPayload)
            expect(JSON.parse(zip.readAsText('conversations/chat_events.json'))).toHaveLength(1)
            expect(zip.getEntry('conversations/artifacts/c1/images/picture.png')).not.toBeNull()
            expect(zip.readAsText('conversations/attachment-assets/asset1/original')).toBe('original document')
            expect(JSON.parse(zip.readAsText('conversations/attachment_assets.json'))).toHaveLength(1)
            db.prepare('DELETE FROM chat_events').run()
            db.prepare('DELETE FROM message_attachments').run()
            db.prepare('DELETE FROM attachment_assets').run()
            db.prepare('DELETE FROM messages').run()
            db.prepare('DELETE FROM conversations').run()
            rmSync(join(getAppDataDir(), 'artifacts'), { recursive: true, force: true })
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
            const blocks = JSON.parse((db.prepare('SELECT content_blocks_json FROM messages WHERE id = ?').get('m1') as { content_blocks_json: string }).content_blocks_json)
            expect(blocks[0].url).toBe(`/api/files?path=${encodeURIComponent(imagePath)}`)
            expect(readFileSync(imagePath, 'utf8')).toBe('image bytes')
            const restoredAsset = db.prepare('SELECT * FROM attachment_assets WHERE id = ?').get('asset1') as { original_path: string; text_path: string }
            expect(readFileSync(restoredAsset.original_path, 'utf8')).toBe('original document')
            expect(existsSync(restoredAsset.text_path)).toBe(true)
            expect(db.prepare('SELECT asset_id FROM message_attachments WHERE id = ?').get('attachment1')).toEqual({ asset_id: 'asset1' })
            expect(db.prepare('SELECT execution_id FROM chat_events WHERE conversation_id = ?').all('c1')).toEqual([{ execution_id: 'e1' }])
            expect(db.prepare('SELECT message_id FROM dream_message_events WHERE message_id = ?').all('m1')).toEqual([])
        } finally {
            await app.close()
        }
    })

    test('skips attachment assets whose files are missing instead of failing the export', async () => {
        const db = getDb()
        db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('c-missing', 'Chat', 1, 1)
        db.prepare('INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
            .run('m-missing', 'c-missing', 'user', 'Hello', 1)
        db.prepare(`INSERT INTO attachment_assets (id, name, original_path, text_path, size_bytes, text_bytes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run('gone-asset', 'gone.txt', '/nonexistent/gone.txt', '/nonexistent/gone.txt.parsed.md', 1, 0, 1)
        db.prepare(`INSERT INTO message_attachments
            (id, message_id, conversation_id, kind, name, original_path, text_path, size_bytes, text_bytes, asset_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run('attachment-missing', 'm-missing', 'c-missing', 'file', 'gone.txt', '/nonexistent/gone.txt', '/nonexistent/gone.txt.parsed.md', 1, 0, 'gone-asset', 1)
        const app = Fastify()
        await app.register(async registeredApp => registerBackupRoutes(registeredApp), { prefix: '/api/backup' })
        try {
            const exported = await app.inject({ method: 'GET', url: '/api/backup/export?modules=conversations' })
            expect(exported.statusCode, exported.body).toBe(200)
            expect(exported.headers['x-backup-warning-count']).toBe('1')
            const zip = new AdmZip(exported.rawPayload)
            expect(JSON.parse(zip.readAsText('conversations/attachment_assets.json'))).toEqual([])
            expect(JSON.parse(zip.readAsText('conversations/message_attachments.json'))).toHaveLength(1)
            expect(JSON.parse(zip.readAsText('manifest.json')).warnings).toEqual([
                'Attachment asset gone-asset is missing its file on disk and was skipped',
            ])
            expect(JSON.parse(zip.readAsText('manifest.json')).skippedAttachmentAssetIds).toEqual(['gone-asset'])

            db.prepare('DELETE FROM message_attachments').run()
            db.prepare('DELETE FROM attachment_assets').run()
            db.prepare('DELETE FROM messages').run()
            db.prepare('DELETE FROM conversations').run()
            const boundary = '----cynosure-missing-asset-test'
            const payload = Buffer.concat([
                Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="backup.zip"\r\nContent-Type: application/zip\r\n\r\n`),
                exported.rawPayload,
                Buffer.from(`\r\n--${boundary}--\r\n`),
            ])
            const imported = await app.inject({ method: 'POST', url: '/api/backup/import',
                headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(payload.length) },
                payload })
            expect(imported.statusCode, imported.body).toBe(200)
            const conversations = imported.json().results.conversations
            expect(conversations.errors).toEqual([])
            expect(conversations.warnings).toEqual([
                'Attachment "gone.txt" was not restored: its file was already missing when the backup was created',
            ])
            expect(db.prepare('SELECT id FROM messages WHERE id = ?').get('m-missing')).toEqual({ id: 'm-missing' })
        } finally {
            db.prepare('DELETE FROM message_attachments').run()
            db.prepare('DELETE FROM attachment_assets').run()
            db.prepare('DELETE FROM messages').run()
            db.prepare('DELETE FROM conversations').run()
            await app.close()
        }
    })

    test('restores current memory without carrying revision history from old backups', async () => {
        const db = getDb()
        const memoryFile = join(getDefaultMemoryFolderDir(), 'note.md')
        writeFileSync(memoryFile, 'Current memory')
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
            expect(memoryMetadata.revisions).toBeUndefined()
            memoryMetadata.revisions = [{
                id: 'old-revision', document_id: 'doc-1', revision_number: 2,
                content_hash: 'old-hash', content: 'Old memory', source: 'legacy-source', created_at: 2,
            }]
            writeFileSync(memoryFile, 'Changed after export')
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
            expect(imported.json().results.memory.restored).toBe(1)
            expect(readFileSync(memoryFile, 'utf-8')).toBe('Current memory')
            expect(db.prepare('SELECT document_ref FROM memory_documents WHERE document_id = ?').get('doc-1'))
                .toEqual({ document_ref: 'memory://doc-1' })
            expect(db.prepare('SELECT COUNT(*) AS count FROM memory_document_revisions').get()).toEqual({ count: 0 })
        } finally {
            await app.close()
        }
    })

    test('round-trips every column of the configuration tables', async () => {
        const db = getDb()
        db.prepare(`INSERT INTO agents (id, name, reasoning_effort, memory_enabled, dreaming_enabled, icon_data, icon_mime, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('agent-1', 'Agent', 'high', 0, 0, Buffer.from('icon'), 'image/png', 1, 2)
        db.prepare('INSERT INTO mcp_servers (id, name, original_name, command, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run('mcp-1', 'Server', 'Server', 'run-server', 0, 1, 2)
        db.prepare('INSERT INTO cron_jobs (id, agent_id, schedule, enabled, notification_mode, last_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run('cron-1', 'agent-1', '0 * * * *', 0, 'conditional', 5, 1, 2)
        db.prepare('INSERT INTO channels (id, name, type, agent_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run('channel-1', 'Channel', 'telegram', 'agent-1', 0, 1, 2)
        db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)').run('theme', JSON.stringify('dark'))
        db.prepare('INSERT INTO tool_approvals (tool_name, auto_approve) VALUES (?, ?)').run('tool-1', 1)
        const tables = ['agents', 'mcp_servers', 'cron_jobs', 'channels', 'settings', 'tool_approvals']
        const snapshot = () => Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]))
        const before = snapshot()

        const app = Fastify()
        await app.register(async registeredApp => registerBackupRoutes(registeredApp), { prefix: '/api/backup' })
        try {
            const exported = await app.inject({ method: 'GET', url: '/api/backup/export?modules=agents,mcp,settings,channels' })
            expect(exported.statusCode).toBe(200)
            for (const table of tables) db.prepare(`DELETE FROM ${table}`).run()

            const boundary = '----cynosure-config-backup-test'
            const payload = Buffer.concat([
                Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="backup.zip"\r\nContent-Type: application/zip\r\n\r\n`),
                exported.rawPayload,
                Buffer.from(`\r\n--${boundary}--\r\n`),
            ])
            const imported = await app.inject({ method: 'POST', url: '/api/backup/import',
                headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(payload.length) },
                payload })
            expect(imported.statusCode, imported.body).toBe(200)
            expect(imported.json().results).toEqual({
                agents: { restored: 1, errors: [] },
                mcp: { restored: 1, errors: [] },
                settings: { restored: 3, errors: [] },
                channels: { restored: 1, errors: [] },
            })
            expect(snapshot()).toEqual(before)
        } finally {
            await app.close()
        }
    })

    test('restores old archives that carry removed columns and legacy names', async () => {
        const db = getDb()
        const zip = new AdmZip()
        zip.addFile('manifest.json', Buffer.from(JSON.stringify({ version: 1, createdAt: '', modules: { agents: { count: 1 } } })))
        zip.addFile('agents/_db_agents.json', Buffer.from(JSON.stringify([{
            id: 'legacy-agent', name: 'Legacy', codename: 'legacy', description: null,
            tool_router_model: 'dropped-model', tags_json: '["dropped"]',
        }])))
        const app = Fastify()
        await app.register(async registeredApp => registerBackupRoutes(registeredApp), { prefix: '/api/backup' })
        try {
            const boundary = '----cynosure-legacy-backup-test'
            const payload = Buffer.concat([
                Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="backup.zip"\r\nContent-Type: application/zip\r\n\r\n`),
                zip.toBuffer(),
                Buffer.from(`\r\n--${boundary}--\r\n`),
            ])
            const imported = await app.inject({ method: 'POST', url: '/api/backup/import',
                headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(payload.length) },
                payload })
            expect(imported.statusCode, imported.body).toBe(200)
            expect(imported.json().results.agents).toEqual({ restored: 1, errors: [] })
            expect(db.prepare('SELECT internal_name, description, reasoning_effort FROM agents WHERE id = ?').get('legacy-agent'))
                .toEqual({ internal_name: 'legacy', description: '', reasoning_effort: 'medium' })
        } finally {
            await app.close()
        }
    })
})
