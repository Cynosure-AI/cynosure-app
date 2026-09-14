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
        expect(result.applied).toEqual([1])
        expect(result.to).toBe(SCHEMA_VERSION)
        expect(getUserVersion(db)).toBe(SCHEMA_VERSION)
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

    test('adopts a populated pre-versioning database without dropping its data', () => {
        const db = memoryDb()
        db.exec('CREATE TABLE legacy_thing (id TEXT PRIMARY KEY)')
        db.exec("INSERT INTO legacy_thing (id) VALUES ('kept')")

        const result = applySchemaMigrations(db)

        // The baseline is idempotent, so the existing table survives and the
        // database is stamped with the current version.
        expect(result.applied).toEqual([1])
        expect(getUserVersion(db)).toBe(SCHEMA_VERSION)
        expect(tableNames(db)).toContain('legacy_thing')
        expect(db.prepare('SELECT id FROM legacy_thing').get()).toEqual({ id: 'kept' })
        db.close()
    })

    test('leaves an empty database untouched until the baseline applies', () => {
        const db = memoryDb()
        // An empty file has no user tables, so it is treated as brand new.
        const result = applySchemaMigrations(db)

        expect(result.applied).toEqual([1])
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
