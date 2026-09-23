import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { closeDb, getDb } from '../../db/database.js'
import { activatePermanentMemoryIndex, getActivePermanentMemoryProfileFingerprint, getActivePermanentMemoryTableName } from './memory-index-manifest.js'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'cynosure-memory-profile-'))
  process.env.CYNOSURE_DATA_DIR = directory
  getDb()
})
afterEach(() => {
  closeDb()
  delete process.env.CYNOSURE_DATA_DIR
  rmSync(directory, { recursive: true, force: true })
})

test('activates an index with its embedding profile and configuration together', () => {
  const config = { providerId: 'provider', model: 'embed', dimensions: 2 }
  activatePermanentMemoryIndex('permanent_memory_v_test', config, 'profile-a')
  expect(getActivePermanentMemoryTableName()).toBe('permanent_memory_v_test')
  expect(getActivePermanentMemoryProfileFingerprint()).toBe('profile-a')
  expect(JSON.parse((getDb().prepare("SELECT value_json FROM settings WHERE key = 'embedding'").get() as { value_json: string }).value_json))
    .toEqual(config)
})
