import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb, getDbPath } from './database.js'
import { DatabaseVersionError, SCHEMA_VERSION, getUserVersion } from './migrations.js'

let directory = ''
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cynosure-database-'))
    process.env.CYNOSURE_DATA_DIR = directory
})
afterEach(async () => {
    closeDb()
    delete process.env.CYNOSURE_DATA_DIR
    await rm(directory, { recursive: true, force: true })
})

test('refuses a database from a newer build without caching the unmigrated handle', () => {
    const future = new Database(getDbPath())
    future.pragma(`user_version = ${SCHEMA_VERSION + 1}`)
    future.close()

    expect(() => getDb()).toThrow(DatabaseVersionError)
    // A second call must re-check rather than hand out the handle that failed.
    expect(() => getDb()).toThrow(DatabaseVersionError)

    const reopened = new Database(getDbPath())
    expect(getUserVersion(reopened)).toBe(SCHEMA_VERSION + 1)
    reopened.close()
})
