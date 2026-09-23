import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { closeDb, getDb } from '../../db/database.js'
import { loadCachedToolEmbeddings, saveCachedToolEmbedding } from './router-embedding-cache.js'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'cynosure-router-profile-'))
  process.env.CYNOSURE_DATA_DIR = directory
  getDb()
})
afterEach(() => {
  closeDb()
  delete process.env.CYNOSURE_DATA_DIR
  rmSync(directory, { recursive: true, force: true })
})

test('tool vectors are reusable only for the generating profile', () => {
  const common = { providerId: 'provider', model: 'model', dimensions: 2 }
  const original = { ...common, fingerprint: 'profile-a' }
  const rotated = { ...common, fingerprint: 'profile-b' }
  const hashes = new Map([['search', 'content-a']])
  saveCachedToolEmbedding('search', 'content-a', [1, 0], original)
  expect(loadCachedToolEmbeddings(['search'], hashes, original).get('search')).toEqual([1, 0])
  expect(loadCachedToolEmbeddings(['search'], hashes, rotated).size).toBe(0)
  saveCachedToolEmbedding('search', 'content-a', [0, 1], rotated)
  expect(loadCachedToolEmbeddings(['search'], hashes, rotated).get('search')).toEqual([0, 1])
  expect(loadCachedToolEmbeddings(['search'], hashes, original).size).toBe(0)
})
