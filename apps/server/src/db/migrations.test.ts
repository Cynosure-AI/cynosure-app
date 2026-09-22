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
        expect(result.applied).toEqual([1, 2, 3, 4, 5, 6, 7])
        expect(result.to).toBe(SCHEMA_VERSION)
        expect(getUserVersion(db)).toBe(SCHEMA_VERSION)
        expect((db.prepare(`PRAGMA table_info(memory_knowledge_text_units)`).all() as Array<{ name: string }>).map((column) => column.name)).toContain('summary')
        expect((db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>).map((column) => column.name)).not.toContain('tags_json')
        expect((db.prepare(`PRAGMA table_info(staged_chat_attachments)`).all() as Array<{ name: string }>).map((column) => column.name))
            .toEqual(expect.arrayContaining(['client_id', 'status', 'progress_current', 'progress_total', 'error', 'updated_at']))
        expect((db.prepare(`PRAGMA table_info(memory_folders)`).all() as Array<{ name: string }>).map((column) => column.name))
            .toContain('auto_memory_excluded')
        expect((db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map((column) => column.name))
            .toContain('content_blocks_json')
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

    test('the baseline schema creates the expected core tables', () => {
        const db = memoryDb()
        applySchemaMigrations(db)
        const names = tableNames(db)

        for (const expected of [
            'agents', 'conversations', 'messages', 'providers', 'settings',
            'memory_folders', 'memory_file_index', 'memory_documents',
            'memory_knowledge_entities', 'memory_knowledge_assertions',
            'dream_progress', 'memory_index_jobs', 'subagent_sessions',
        ]) {
            expect(names).toContain(expected)
        }
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

        expect(result.applied).toEqual([1, 2, 3, 4, 5, 6, 7])
        expect(getUserVersion(db)).toBe(SCHEMA_VERSION)
        expect(tableNames(db)).not.toContain('obsolete_table')
        expect(tableNames(db)).toContain('agents')
        db.close()
    })

    test('leaves an empty database untouched until the baseline applies', () => {
        const db = memoryDb()
        // An empty file has no user tables, so it is treated as brand new.
        const result = applySchemaMigrations(db)

        expect(result.applied).toEqual([1, 2, 3, 4, 5, 6, 7])
        db.close()
    })

    test('renames persisted in-app notification tool selections', () => {
        const db = memoryDb()
        applySchemaMigrations(db)
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

        expect(result.applied).toEqual([3, 4, 5, 6, 7])
        expect((db.prepare("SELECT tools_json FROM agents WHERE id = 'agent-1'").get() as { tools_json: string }).tools_json)
            .toContain('builtin:notifications::notify_user_in_app')
        expect((db.prepare("SELECT execution_config_json FROM conversations WHERE id = 'conversation-1'").get() as { execution_config_json: string }).execution_config_json)
            .toContain('builtin:notifications::notify_user_in_app')
        expect((db.prepare("SELECT execution_config_json FROM cron_jobs WHERE id = 'cron-1'").get() as { execution_config_json: string }).execution_config_json)
            .toContain('builtin:notifications::notify_user_in_app')
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

        expect(applySchemaMigrations(db).applied).toEqual([6, 7])
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
