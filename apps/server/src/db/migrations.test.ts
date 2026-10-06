import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { BASELINE_SCHEMA } from './schema.js'
import {
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
    test('a fresh database is created at the current schema version', () => {
        const db = memoryDb()
        const result = applySchemaMigrations(db)

        expect(result.from).toBe(0)
        expect(result.applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22])
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
        db.close()
    })

    test('moves existing notification selections into utilities', () => {
        const db = memoryDb()
        applySchemaMigrations(db)
        db.pragma('user_version = 14')
        const now = Date.now()
        db.prepare('INSERT INTO agents (id, name, tools_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('agent', 'Agent', JSON.stringify(['builtin:notifications::notify_user']), now, now)
        expect(applySchemaMigrations(db).applied).toEqual([15, 16, 17, 18, 19, 20, 21, 22])
        expect((db.prepare('SELECT tools_json FROM agents').get() as { tools_json: string }).tools_json)
            .toBe(JSON.stringify(['builtin:utility::notify_user']))
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
        db.close()
    })

    test('rebuilds a populated pre-versioning database from the v1 baseline', () => {
        const db = memoryDb()
        db.exec('CREATE TABLE obsolete_table (id TEXT PRIMARY KEY)')
        db.exec("INSERT INTO obsolete_table (id) VALUES ('discarded')")

        const result = applySchemaMigrations(db)

        expect(result.applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22])
        expect(getUserVersion(db)).toBe(SCHEMA_VERSION)
        expect(tableNames(db)).not.toContain('obsolete_table')
        expect(tableNames(db)).toContain('agents')
        db.close()
    })

    test('leaves an empty database untouched until the baseline applies', () => {
        const db = memoryDb()
        // An empty file has no user tables, so it is treated as brand new.
        const result = applySchemaMigrations(db)

        expect(result.applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22])
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

        expect(result.applied).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22])
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
        expect(applySchemaMigrations(db).applied).toEqual([14, 15, 16, 17, 18, 19, 20, 21, 22])
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

        expect(applySchemaMigrations(db).applied).toEqual([13, 14, 15, 16, 17, 18, 19, 20, 21, 22])
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

        expect(applySchemaMigrations(db).applied).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22])
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
