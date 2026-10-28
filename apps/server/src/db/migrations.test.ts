import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { BASELINE_SCHEMA } from './schema.js'
import {
    DatabaseVersionError,
    SCHEMA_VERSION,
    applySchemaMigrations,
    getUserVersion,
} from './migrations.js'

function memoryDb(): Database.Database {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    return db
}

function tableNames(db: Database.Database): string[] {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
        .map((row) => row.name)
}

describe('schema migrations', () => {
    test('registers legacy draft and queue files for content deduplication', () => {
        const db = memoryDb()
        applySchemaMigrations(db)
        db.exec('DROP INDEX idx_attachment_assets_content_hash; DROP INDEX idx_attachment_assets_unhashed_size; ALTER TABLE attachment_assets DROP COLUMN content_hash')
        db.pragma('user_version = 29')
        db.prepare('INSERT INTO conversations (id, created_at, updated_at) VALUES (?, 1, 1)').run('chat')
        const draft = { id: 'draft', name: 'draft.txt', originalPath: '/draft.txt', textPath: '/draft.md', sizeBytes: 5, textBytes: 5, chunkCount: 1 }
        const queued = { ...draft, id: 'queued', assetId: 'shared-asset' }
        db.prepare('INSERT INTO staged_chat_attachments (id, conversation_id, artifact_json, created_at) VALUES (?, ?, ?, 1)')
            .run(draft.id, 'chat', JSON.stringify(draft))
        db.prepare('INSERT INTO queued_chat_messages (id, conversation_id, content, position, file_artifacts_json, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, 1)')
            .run('queue', 'chat', '', JSON.stringify([queued]))

        expect(applySchemaMigrations(db).applied).toEqual([30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44])
        expect(db.prepare('SELECT id, chunk_count, content_hash FROM attachment_assets ORDER BY id').all()).toEqual([
            { id: 'draft', chunk_count: 1, content_hash: null },
            { id: 'shared-asset', chunk_count: 1, content_hash: null },
        ])
        expect(applySchemaMigrations(db).applied).toEqual([])
        db.close()
    })

    test('a fresh database is created at the current schema version', () => {
        const db = memoryDb()
        const result = applySchemaMigrations(db)

        expect(result.from).toBe(0)
        expect(result.applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44])
        expect(result.to).toBe(SCHEMA_VERSION)
        expect(getUserVersion(db)).toBe(SCHEMA_VERSION)
        expect(tableNames(db)).not.toContain('execution_steps')
        expect((db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>).map((column) => column.name)).not.toContain('tags_json')
        expect((db.prepare(`PRAGMA table_info(staged_chat_attachments)`).all() as Array<{ name: string }>).map((column) => column.name))
            .toEqual(expect.arrayContaining(['client_id', 'status', 'progress_current', 'progress_total', 'error', 'updated_at']))
        expect((db.prepare(`PRAGMA table_info(memory_folders)`).all() as Array<{ name: string }>).map((column) => column.name))
            .toContain('auto_memory_excluded')
        expect((db.prepare(`PRAGMA table_info(memory_file_index)`).all() as Array<{ name: string }>).map((column) => column.name))
            .not.toContain('tags_json')
        expect((db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>).map((column) => column.name))
            .toContain('stopped')
        expect(tableNames(db)).toContain('channel_deliveries')
        expect((db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>).map((column) => column.name))
            .toContain('scheduled_brief_updates')
        expect((db.prepare(`PRAGMA table_info(conversations)`).all() as Array<{ name: string }>).map((column) => column.name))
            .toContain('temporary')
        db.close()
    })

    test('turns the all-tools session approval into a full access permission mode', () => {
        const db = memoryDb()
        applySchemaMigrations(db)
        db.exec('ALTER TABLE conversations DROP COLUMN permission_mode')
        db.pragma('user_version = 32')
        db.prepare('INSERT INTO conversations (id, created_at, updated_at) VALUES (?, 1, 1)').run('full-chat')
        db.prepare('INSERT INTO conversations (id, created_at, updated_at) VALUES (?, 1, 1)').run('plain-chat')
        db.prepare('INSERT INTO session_tool_approvals (conversation_id, tool_name, created_at) VALUES (?, ?, 1)').run('full-chat', '*')
        db.prepare('INSERT INTO session_tool_approvals (conversation_id, tool_name, created_at) VALUES (?, ?, 1)').run('full-chat', 'shell')

        expect(applySchemaMigrations(db).applied).toEqual([33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44])
        expect(db.prepare('SELECT id, permission_mode FROM conversations ORDER BY id').all()).toEqual([
            { id: 'full-chat', permission_mode: 'full' },
            { id: 'plain-chat', permission_mode: 'auto' },
        ])
        expect(db.prepare('SELECT tool_name FROM session_tool_approvals').all()).toEqual([{ tool_name: 'shell' }])
        db.close()
    })

    test('keeps permission modes and allows edit when widening the mode list', () => {
        const db = memoryDb()
        applySchemaMigrations(db)
        db.prepare('INSERT INTO conversations (id, created_at, updated_at, permission_mode) VALUES (?, 1, 1, ?)').run('full-chat', 'full')
        db.prepare('INSERT INTO conversations (id, created_at, updated_at) VALUES (?, 1, 1)').run('plain-chat')
        db.prepare('UPDATE conversations SET permission_mode = ? WHERE id = ?').run('edit', 'plain-chat')
        expect(db.prepare('SELECT id, permission_mode FROM conversations ORDER BY id').all()).toEqual([
            { id: 'full-chat', permission_mode: 'full' },
            { id: 'plain-chat', permission_mode: 'edit' },
        ])
        expect(() => db.prepare('UPDATE conversations SET permission_mode = ? WHERE id = ?').run('bogus', 'plain-chat')).toThrow()
        db.close()
    })

    test('marks existing chats as saved when adding the temporary flag', () => {
        const db = memoryDb()
        applySchemaMigrations(db)
        db.exec('ALTER TABLE conversations DROP COLUMN temporary')
        db.pragma('user_version = 31')
        db.prepare('INSERT INTO conversations (id, created_at, updated_at) VALUES (?, 1, 1)').run('chat')

        expect(applySchemaMigrations(db).applied).toEqual([32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44])
        expect(db.prepare('SELECT temporary FROM conversations').get()).toEqual({ temporary: 0 })
        db.close()
    })

    test('keeps one copy of memory pipeline stats per routing decision', () => {
        const db = memoryDb()
        applySchemaMigrations(db)
        db.pragma('user_version = 37')
        db.prepare('INSERT INTO conversations (id, created_at, updated_at) VALUES (?, 1, 1)').run('chat')
        const stats = { queryCount: 1, searchMatches: [{ id: 'a' }] }
        const entry = (name: string) => ({ name, details: { type: 'memory', pipelineStats: stats } })
        db.prepare("INSERT INTO chat_events (conversation_id, execution_id, event_json, created_at) VALUES ('chat', 'e1', ?, 1)")
            .run(JSON.stringify({ type: 'routing-decision', taskId: 't', phase: 'memory-candidates', entries: [entry('a'), entry('b'), entry('c')] }))

        applySchemaMigrations(db)

        const event = JSON.parse(db.prepare('SELECT event_json FROM chat_events').pluck().get() as string)
        expect(event.entries.map((item: { details: { pipelineStats?: unknown } }) => item.details.pipelineStats)).toEqual([stats, undefined, undefined])
        db.close()
    })

    test('converts router embedding vectors to Float32 blobs without changing them', () => {
        const db = memoryDb()
        applySchemaMigrations(db)
        db.exec('ALTER TABLE tool_router_tool_embeddings DROP COLUMN vector')
        db.exec("ALTER TABLE tool_router_tool_embeddings ADD COLUMN vector_json TEXT NOT NULL DEFAULT '[]'")
        db.pragma('user_version = 39')
        const vector = [-0.006056420039385557, 0.00035717349, 0.25].map(Math.fround)
        db.prepare(`INSERT INTO tool_router_tool_embeddings (tool_name, embedding_model, embedding_dimensions, content_hash, vector_json, updated_at)
            VALUES ('search', 'model', 3, 'hash', ?, 1), ('broken', 'model', 3, 'hash', 'not json', 1)`).run(JSON.stringify(vector))

        applySchemaMigrations(db)

        const rows = db.prepare('SELECT tool_name, vector FROM tool_router_tool_embeddings').all() as Array<{ tool_name: string; vector: Buffer }>
        expect(rows.map((row) => row.tool_name)).toEqual(['search'])
        expect(Array.from(new Float32Array(rows[0].vector.buffer.slice(rows[0].vector.byteOffset, rows[0].vector.byteOffset + 12)))).toEqual(vector)
        db.close()
    })

    test('shortens stored tool output to a preview only where the content blocks hold it in full', () => {
        const db = memoryDb()
        applySchemaMigrations(db)
        db.pragma('user_version = 40')
        db.prepare('INSERT INTO conversations (id, created_at, updated_at) VALUES (?, 1, 1)').run('chat')
        const long = 'y'.repeat(800)
        const insert = db.prepare("INSERT INTO messages (id, conversation_id, role, content, content_blocks_json, created_at) VALUES (?, 'chat', ?, ?, ?, 1)")
        insert.run('tool', 'tool', long, JSON.stringify([{ type: 'text', text: long }, { type: 'structured', value: {} }]))
        insert.run('tool-mismatch', 'tool', long, JSON.stringify([{ type: 'text', text: 'different' }]))
        insert.run('assistant', 'assistant', long, JSON.stringify([{ type: 'text', text: long }]))

        applySchemaMigrations(db)

        const content = Object.fromEntries((db.prepare('SELECT id, content FROM messages').all() as Array<{ id: string; content: string }>)
            .map((row) => [row.id, row.content.length]))
        expect(content).toEqual({ tool: 501, 'tool-mismatch': 800, assistant: 800 })
        db.close()
    })

    test('drops the in-app notifications table', () => {
        const db = memoryDb()
        applySchemaMigrations(db)
        db.pragma('user_version = 43')
        db.exec("CREATE TABLE notifications (id TEXT PRIMARY KEY); INSERT INTO notifications VALUES ('old')")

        expect(applySchemaMigrations(db).applied).toEqual([44])
        expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notifications'").get()).toBeUndefined()
        db.close()
    })

    test('moves existing notification selections into utilities', () => {
        const db = memoryDb()
        applySchemaMigrations(db)
        db.pragma('user_version = 14')
        const now = Date.now()
        db.prepare('INSERT INTO agents (id, name, tools_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('agent', 'Agent', JSON.stringify(['builtin:notifications::notify_user']), now, now)
        expect(applySchemaMigrations(db).applied).toEqual([15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44])
        expect((db.prepare('SELECT tools_json FROM agents').get() as { tools_json: string }).tools_json)
            .toBe(JSON.stringify(['builtin:utility::notify_user']))
        db.close()
    })

    test('unlinks project tasks from the chat that only created them', () => {
        const db = memoryDb()
        applySchemaMigrations(db)
        db.pragma('user_version = 30')
        db.prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p', 'Project', 1, 1)").run()
        const task = db.prepare("INSERT INTO project_tasks (id, project_id, title, status, conversation_id, created_by, created_at, updated_at) VALUES (?, 'p', ?, ?, ?, 'agent', 1, 1)")
        const event = db.prepare("INSERT INTO project_events (id, project_id, kind, task_id, to_status, source, conversation_id, created_at) VALUES (?, 'p', ?, ?, ?, 'ai', ?, 1)")
        task.run('created-only', 'Created only', 'todo', 'creator')
        event.run('e1', 'task_created', 'created-only', 'todo', 'creator')
        task.run('started-later', 'Started later', 'in_progress', 'creator')
        event.run('e2', 'task_created', 'started-later', 'todo', 'creator')
        event.run('e3', 'task_updated', 'started-later', 'in_progress', 'creator')
        task.run('created-started', 'Created started', 'in_progress', 'creator')
        event.run('e4', 'task_created', 'created-started', 'in_progress', 'creator')
        task.run('before-timeline', 'Before timeline', 'todo', 'creator')

        expect(applySchemaMigrations(db).applied).toEqual([31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44])
        expect(db.prepare('SELECT id, conversation_id FROM project_tasks ORDER BY id').all()).toEqual([
            { id: 'before-timeline', conversation_id: 'creator' },
            { id: 'created-only', conversation_id: null },
            { id: 'created-started', conversation_id: 'creator' },
            { id: 'started-later', conversation_id: 'creator' },
        ])
        db.close()
    })

    test('moves todo lists from tasks into run_plans', () => {
        const db = memoryDb()
        applySchemaMigrations(db)
        db.pragma('user_version = 28')
        db.exec('DROP TABLE run_plan_project_tasks; DROP TABLE run_plans')
        db.exec(`CREATE TABLE tasks (
            id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id), status TEXT NOT NULL DEFAULT 'pending',
            definition_json TEXT NOT NULL, result_json TEXT, iterations INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL, updated_at INTEGER, completed_at INTEGER
        )`)
        db.prepare('INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)').run('chat', 1, 1)
        const plan = { type: 'planning_state', objective: 'Ship it', items: [{ id: '01', title: 'Build', status: 'in_progress', updatedAt: 2 }], currentTaskId: '01' }
        const insert = db.prepare('INSERT INTO tasks (id, conversation_id, status, definition_json, result_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        insert.run('plan', 'chat', 'running', JSON.stringify(plan), '{"summary":"so far"}', 1, null)
        insert.run('other-type', 'chat', 'running', '{"type":"something_else"}', null, 1, 1)
        insert.run('corrupt', 'chat', 'running', '{broken', null, 1, 1)

        expect(applySchemaMigrations(db).applied).toEqual([29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44])
        expect(tableNames(db)).not.toContain('tasks')
        expect(db.prepare('SELECT * FROM run_plans').all()).toEqual([{
            id: 'plan',
            conversation_id: 'chat',
            status: 'running',
            objective: 'Ship it',
            items_json: JSON.stringify(plan.items),
            current_item_id: '01',
            result_json: '{"summary":"so far"}',
            created_at: 1,
            updated_at: 1,
            completed_at: null,
        }])
        db.close()
    })

    test('running migrations twice is a no-op', () => {
        const db = memoryDb()
        applySchemaMigrations(db)
        const before = tableNames(db)

        const second = applySchemaMigrations(db)

        expect(second.applied).toEqual([])
        expect(second.from).toBe(SCHEMA_VERSION)
        expect(tableNames(db)).toEqual(before)
        db.close()
    })

    test('backfills old messages and drops their redundant media columns', () => {
        const db = memoryDb()
        db.exec(BASELINE_SCHEMA)
        db.pragma('user_version = 1')
        db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('c1', 'Chat', 1, 1)
        db.prepare('INSERT INTO messages (id, conversation_id, role, content, image_urls_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run('old', 'c1', 'user', 'old text', '["/old.png"]', 1)
        applySchemaMigrations(db)
        const read = (id: string) => JSON.parse((db.prepare('SELECT content_blocks_json FROM messages WHERE id = ?').get(id) as { content_blocks_json: string }).content_blocks_json)
        expect(read('old')).toEqual([
            { type: 'text', text: 'old text' },
            { type: 'image', artifactId: '/old.png', url: '/old.png' },
        ])
        const columns = (db.pragma('table_info(messages)') as Array<{ name: string }>).map((column) => column.name)
        for (const removed of ['image_urls_json', 'video_urls_json', 'audio_urls_json', 'thinking', 'structured_content_json']) {
            expect(columns).not.toContain(removed)
        }
        db.prepare('INSERT INTO messages (id, conversation_id, role, content, content_blocks_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run('new', 'c1', 'user', 'new text', JSON.stringify([
                { type: 'text', text: 'new text' }, { type: 'audio', artifactId: '/new.wav', url: '/new.wav' },
            ]), 2)
        expect(read('new')).toEqual([
            { type: 'text', text: 'new text' },
            { type: 'audio', artifactId: '/new.wav', url: '/new.wav' },
        ])
        db.close()
    })

    test('the baseline schema creates the expected core tables', () => {
        const db = memoryDb()
        applySchemaMigrations(db)
        const names = tableNames(db)

        for (const expected of [
            'agents', 'conversations', 'messages', 'providers', 'settings',
            'memory_folders', 'memory_file_index', 'memory_documents',
            'dream_progress', 'memory_index_jobs', 'subagent_sessions', 'chat_events',
        ]) {
            expect(names).toContain(expected)
        }
        db.close()
    })

    test('removes the knowledge graph tables and analysis bookkeeping', () => {
        const db = memoryDb()
        applySchemaMigrations(db)

        expect(tableNames(db).filter((name) => name.startsWith('memory_knowledge_'))).toEqual([])
        const columns = (db.pragma('table_info(memory_file_index)') as Array<{ name: string }>).map((column) => column.name)
        expect(columns).not.toContain('deep_researched_at')
        db.close()
    })

    test('the baseline schema is idempotent', () => {
        const db = memoryDb()
        db.exec(BASELINE_SCHEMA)
        expect(() => db.exec(BASELINE_SCHEMA)).not.toThrow()
        db.close()
    })

    test('refuses a database written by a newer build', () => {
        const db = memoryDb()
        applySchemaMigrations(db)
        db.pragma(`user_version = ${SCHEMA_VERSION + 1}`)

        expect(() => applySchemaMigrations(db)).toThrow(/newer version of Cynosure/)
        expect(() => applySchemaMigrations(db)).toThrow(expect.objectContaining({
            databaseVersion: SCHEMA_VERSION + 1,
            supportedVersion: SCHEMA_VERSION,
        }))
        expect(() => applySchemaMigrations(db)).toThrow(DatabaseVersionError)
        expect(getUserVersion(db)).toBe(SCHEMA_VERSION + 1)
        db.close()
    })

    test('rebuilds a populated pre-versioning database from the v1 baseline', () => {
        const db = memoryDb()
        db.exec('CREATE TABLE obsolete_table (id TEXT PRIMARY KEY)')
        db.exec("INSERT INTO obsolete_table (id) VALUES ('discarded')")

        const result = applySchemaMigrations(db)

        expect(result.applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44])
        expect(getUserVersion(db)).toBe(SCHEMA_VERSION)
        expect(tableNames(db)).not.toContain('obsolete_table')
        expect(tableNames(db)).toContain('agents')
        db.close()
    })

    test('leaves an empty database untouched until the baseline applies', () => {
        const db = memoryDb()
        // An empty file has no user tables, so it is treated as brand new.
        const result = applySchemaMigrations(db)

        expect(result.applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44])
        db.close()
    })

    test('renames persisted in-app notification tool selections', () => {
        const db = memoryDb()
        db.exec(BASELINE_SCHEMA)
        db.exec("ALTER TABLE memory_knowledge_text_units ADD COLUMN summary TEXT NOT NULL DEFAULT ''")
        const now = Date.now()
        db.prepare(`
            INSERT INTO agents (id, name, tools_json, created_at, updated_at)
            VALUES ('agent-1', 'Agent', '["builtin:notifications::create_app_notification"]', ?, ?)
        `).run(now, now)
        db.prepare(`
            INSERT INTO conversations (id, execution_config_json, created_at, updated_at)
            VALUES ('conversation-1', '{"allowedTools":["builtin:notifications::create_app_notification"]}', ?, ?)
        `).run(now, now)
        db.prepare(`
            INSERT INTO cron_jobs (id, agent_id, schedule, execution_config_json, created_at, updated_at)
            VALUES ('cron-1', 'agent-1', '0 9 * * *', '{"allowedTools":["builtin:notifications::create_app_notification"]}', ?, ?)
        `).run(now, now)
        db.pragma('user_version = 2')

        const result = applySchemaMigrations(db)

        expect(result.applied).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44])
        expect((db.prepare("SELECT tools_json FROM agents WHERE id = 'agent-1'").get() as { tools_json: string }).tools_json)
            .toContain('builtin:utility::notify_user')
        expect((db.prepare("SELECT execution_config_json FROM conversations WHERE id = 'conversation-1'").get() as { execution_config_json: string }).execution_config_json)
            .toContain('builtin:utility::notify_user')
        expect((db.prepare("SELECT execution_config_json FROM cron_jobs WHERE id = 'cron-1'").get() as { execution_config_json: string }).execution_config_json)
            .toContain('builtin:utility::notify_user')
        db.close()
    })

    test('merges notification selections, deduplicates them, and preserves unrelated config', () => {
        const db = memoryDb()
        applySchemaMigrations(db)
        db.pragma('user_version = 13')
        const app = 'builtin:notifications::notify_user_in_app'
        const channel = 'builtin:notifications::notify_user_on_channel'
        db.prepare('INSERT INTO agents (id, name, tools_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('agent', 'Agent', JSON.stringify([app, channel, 'builtin:utility::manage_mcp']), 1, 1)
        const config = { allowedTools: [channel, app], note: 'notify_user_in_app is mentioned here' }
        db.prepare('INSERT INTO conversations (id, execution_config_json, created_at, updated_at) VALUES (?, ?, ?, ?)')
            .run('chat', JSON.stringify(config), 1, 1)
        db.prepare('INSERT INTO cron_jobs (id, agent_id, schedule, execution_config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run('cron', 'agent', '* * * * *', JSON.stringify(config), 1, 1)
        db.prepare('INSERT INTO tool_approvals (tool_name, auto_approve) VALUES (?, ?)').run('notify_user_in_app', 1)
        db.prepare('INSERT INTO session_tool_approvals (conversation_id, tool_name, created_at) VALUES (?, ?, ?)')
            .run('chat', 'notify_user_in_app', 1)
        expect(applySchemaMigrations(db).applied).toEqual([14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44])
        const agent = db.prepare('SELECT tools_json FROM agents').get() as { tools_json: string }
        expect(JSON.parse(agent.tools_json)).toEqual(['builtin:utility::notify_user', 'builtin:utility::manage_mcp'])
        for (const table of ['conversations', 'cron_jobs']) {
            const row = db.prepare(`SELECT execution_config_json FROM ${table}`).get() as { execution_config_json: string }
            expect(JSON.parse(row.execution_config_json)).toEqual({ ...config, allowedTools: ['builtin:utility::notify_user'] })
        }
        expect(db.prepare('SELECT * FROM tool_approvals').all()).toEqual([{ tool_name: 'notify_user', auto_approve: 0 }])
        expect(db.prepare('SELECT * FROM session_tool_approvals').all()).toEqual([])
        db.close()
    })

    test('renames saved directory tool selections and approval settings', () => {
        const db = memoryDb()
        applySchemaMigrations(db)
        db.pragma('user_version = 12')
        const now = Date.now()
        db.prepare('INSERT INTO agents (id, name, tools_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('agent-1', 'Agent', JSON.stringify(['builtin:files::file_list_directory', 'builtin:files::file_create_directory', 'builtin:files::file_merge']), now, now)
        db.prepare('INSERT INTO conversations (id, execution_config_json, created_at, updated_at) VALUES (?, ?, ?, ?)')
            .run('conversation-1', JSON.stringify({ allowedTools: ['builtin:files::file_merge'], note: 'file_merge is mentioned here' }), now, now)
        db.prepare('INSERT INTO cron_jobs (id, agent_id, schedule, execution_config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run('cron-1', 'agent-1', '0 9 * * *', JSON.stringify({ allowedTools: ['builtin:files::file_create_directory'] }), now, now)
        db.prepare('INSERT INTO tool_approvals (tool_name, auto_approve) VALUES (?, ?)').run('file_merge', 1)
        db.prepare('INSERT INTO tool_approvals (tool_name, auto_approve) VALUES (?, ?)').run('built_in_files__file_create_directory', 0)
        db.prepare('INSERT INTO session_tool_approvals (conversation_id, tool_name, created_at) VALUES (?, ?, ?)').run('conversation-1', 'file_merge', now)

        expect(applySchemaMigrations(db).applied).toEqual([13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44])
        const agent = db.prepare('SELECT tools_json FROM agents WHERE id = ?').get('agent-1') as { tools_json: string }
        expect(JSON.parse(agent.tools_json)).toEqual([
            'builtin:files::directory_list', 'builtin:files::directory_create', 'builtin:files::directory_merge',
        ])
        const conversation = db.prepare('SELECT execution_config_json FROM conversations WHERE id = ?').get('conversation-1') as { execution_config_json: string }
        expect(JSON.parse(conversation.execution_config_json)).toEqual({ allowedTools: ['builtin:files::directory_merge'], note: 'file_merge is mentioned here' })
        const cron = db.prepare('SELECT execution_config_json FROM cron_jobs WHERE id = ?').get('cron-1') as { execution_config_json: string }
        expect(JSON.parse(cron.execution_config_json)).toEqual({ allowedTools: ['builtin:files::directory_create'] })
        expect(db.prepare('SELECT auto_approve FROM tool_approvals WHERE tool_name = ?').get('directory_merge')).toEqual({ auto_approve: 1 })
        expect(db.prepare('SELECT auto_approve FROM tool_approvals WHERE tool_name = ?').get('built_in_files__directory_create')).toEqual({ auto_approve: 0 })
        expect(db.prepare('SELECT tool_name FROM session_tool_approvals WHERE conversation_id = ?').get('conversation-1')).toEqual({ tool_name: 'directory_merge' })
        db.close()
    })

    test('preserves legacy automatic-memory exclusions when adding the folder setting', () => {
        const db = memoryDb()
        db.exec(BASELINE_SCHEMA)
        db.pragma('user_version = 5')
        const now = Date.now()
        const insert = db.prepare(`
            INSERT INTO memory_folders (id, name, directory_path, created_at)
            VALUES (?, ?, ?, ?)
        `)
        insert.run('archive', 'Archive', '/memory/Archive', now)
        insert.run('archive-child', '2024', '/memory/Archive/2024', now)
        insert.run('ordinary', 'Projects', '/memory/Projects', now)

        expect(applySchemaMigrations(db).applied).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44])
        const rows = db.prepare('SELECT id, auto_memory_excluded FROM memory_folders ORDER BY id').all() as Array<{
            id: string
            auto_memory_excluded: number
        }>
        expect(rows).toEqual([
            { id: 'archive', auto_memory_excluded: 1 },
            { id: 'archive-child', auto_memory_excluded: 1 },
            { id: 'ordinary', auto_memory_excluded: 0 },
        ])
        db.close()
    })

    test('applies only the migrations newer than the recorded version', () => {
        const db = memoryDb()
        const history = [
            { version: 1, description: 'baseline', up: (d: Database.Database) => d.exec('CREATE TABLE a (id TEXT)') },
            { version: 2, description: 'add b', up: (d: Database.Database) => d.exec('CREATE TABLE b (id TEXT)') },
            { version: 3, description: 'add c', up: (d: Database.Database) => d.exec('CREATE TABLE c (id TEXT)') },
        ]

        applySchemaMigrations(db, history)
        expect(getUserVersion(db)).toBe(3)
        // Already at the tip — nothing to do.
        expect(applySchemaMigrations(db, history).applied).toEqual([])

        // A newer build with one more migration upgrades incrementally.
        const extended = [...history, { version: 4, description: 'add d', up: (d: Database.Database) => d.exec('CREATE TABLE d (id TEXT)') }]
        const result = applySchemaMigrations(db, extended)
        expect(result).toMatchObject({ from: 3, to: 4, applied: [4] })
        expect(tableNames(db)).toContain('d')
        db.close()
    })

    test('drops the per-agent tool and memory router columns', () => {
        const db = memoryDb()
        applySchemaMigrations(db)
        const columns = (db.pragma('table_info(agents)') as Array<{ name: string }>).map(({ name }) => name)
        expect(columns).toEqual(expect.arrayContaining(['auto_router_provider_id', 'auto_router_model']))
        expect(columns.filter((name) => /^(tool|memory)_router_/.test(name))).toEqual([])
        db.close()
    })

    test('a failed migration rolls back and does not advance the version', () => {
        const db = memoryDb()
        const history = [
            { version: 1, description: 'good', up: (d: Database.Database) => d.exec('CREATE TABLE good (id TEXT)') },
            { version: 2, description: 'bad', up: (d: Database.Database) => { d.exec('CREATE TABLE partial (id TEXT)'); d.exec('NOT VALID SQL') } },
        ]

        expect(() => applySchemaMigrations(db, history)).toThrow()

        // v1 committed; v2's partial work rolled back with it.
        expect(getUserVersion(db)).toBe(1)
        expect(tableNames(db)).toEqual(['good'])
        db.close()
    })
})
