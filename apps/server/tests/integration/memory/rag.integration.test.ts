import { expect, test, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as lancedb from '@lancedb/lancedb'
import { RAGStore } from '../../../src/core/memory/rag.js'
import { andLanceDbFilters, lanceDbEqFilter } from '../../../src/core/memory/lancedb-filter.js'

test('migrates legacy categoryId metadata to folderId in place', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cynosure-rag-folder-migration-'))
  const legacy = await lancedb.connect(directory)
  await legacy.createTable('memory', [{
    id: 'legacy', text: 'existing memory', vector: [1, 0, 0], source: 'memory',
    sourceFile: 'existing.md', chunkIndex: 0, categoryId: 'people', createdAt: 1,
  }])

  const store = new RAGStore()
  try {
    await store.initialize(directory)
    expect(await store.listDocuments('memory', lanceDbEqFilter('folderId', 'people'), { throwOnError: true }))
      .toMatchObject([{ id: 'legacy', folderId: 'people' }])

    const migrated = await legacy.openTable('memory')
    const fields = (await migrated.schema()).fields.map((field) => field.name)
    expect(fields).toContain('folderId')
    expect(fields).not.toContain('categoryId')
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('hybrid search retains LanceDB fusion scores for lexical candidates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cynosure-rag-'))
  const store = new RAGStore()
  try {
    await store.initialize(directory)
    await store.addDocuments('memory', [
      { id: 'semantic', text: 'general deployment guidance', searchText: 'general deployment guidance', vector: [1, 0, 0], source: 'test', createdAt: 1 },
      { id: 'lexical', text: 'ExactCode-ZX91 troubleshooting procedure', searchText: 'ExactCode-ZX91 troubleshooting procedure', vector: [0, 1, 0], source: 'test', createdAt: 2 },
      { id: 'other', text: 'unrelated gardening notes', searchText: 'unrelated gardening notes', vector: [0, 0, 1], source: 'test', createdAt: 3 },
    ], 3)
    await store.rebuildFtsIndex('memory')

    const results = await store.hybridSearch('memory', [1, 0, 0], 'ExactCode-ZX91', 3)
    const lexical = results.find((item) => item.id === 'lexical')
    expect(lexical).toBeDefined()
    expect(lexical?.scoreType).toBe('fusion')
    expect(lexical?.score).toBe(lexical?.fusionScore)
    expect(lexical?.fusionScore ?? 0).toBeGreaterThan(0)

    const lexicalOnly = await store.lexicalSearch('memory', 'ExactCode-ZX91', 3)
    expect(lexicalOnly[0]).toMatchObject({ id: 'lexical', scoreType: 'lexical' })
    expect(lexicalOnly[0]?.lexicalScore ?? 0).toBeGreaterThan(0)

  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('concurrent searches share a refresh and reuse a complete index after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cynosure-rag-fts-refresh-'))
  const first = new RAGStore()
  const reopened = new RAGStore()
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    await first.initialize(directory)
    await first.addDocuments('memory', [
      { id: 'initial', text: 'startup context', vector: [1, 0], source: 'test', createdAt: 1 },
    ], 2)
    await first.rebuildFtsIndex('memory')
    await first.close()
    log.mockClear()

    await reopened.initialize(directory)
    const coldResults = await Promise.all(Array.from({ length: 8 }, () =>
      reopened.lexicalSearch('memory', 'startup', 5)))
    expect(coldResults.every(results => results.some(result => result.id === 'initial'))).toBe(true)
    expect(log.mock.calls.filter(([message]) => String(message).includes('FTS index rebuilt for table "memory"'))).toHaveLength(0)

    await reopened.addDocuments('memory', [
      { id: 'new', text: 'fresh context', vector: [0, 1], source: 'test', createdAt: 2 },
    ], 2)
    const updatedResults = await Promise.all(Array.from({ length: 8 }, () =>
      reopened.lexicalSearch('memory', 'fresh', 5)))
    expect(updatedResults.every(results => results.some(result => result.id === 'new'))).toBe(true)
    expect(log.mock.calls.filter(([message]) => String(message).includes('FTS index rebuilt for table "memory"'))).toHaveLength(1)
  } finally {
    log.mockRestore()
    await first.close()
    await reopened.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('concurrent cold searches refresh an index left stale by a restart once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cynosure-rag-stale-fts-'))
  const first = new RAGStore()
  const reopened = new RAGStore()
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    await first.initialize(directory)
    await first.addDocuments('memory', [
      { id: 'pending', text: 'restart recovery', vector: [1, 0], source: 'test', createdAt: 1 },
    ], 2)
    await first.close()
    log.mockClear()

    await reopened.initialize(directory)
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      reopened.lexicalSearch('memory', 'recovery', 5)))
    expect(results.every(matches => matches.some(match => match.id === 'pending'))).toBe(true)
    expect(log.mock.calls.filter(([message]) => String(message).includes('FTS index rebuilt for table "memory"'))).toHaveLength(1)
  } finally {
    log.mockRestore()
    await first.close()
    await reopened.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects searches and writes from a different embedding profile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cynosure-rag-profile-'))
  const store = new RAGStore()
  try {
    await store.initialize(directory)
    const document = { id: 'one', text: 'profiled memory', vector: [1, 0], source: 'test',
      createdAt: 1, embeddingProfileFingerprint: 'profile-a' }
    await store.addDocuments('memory', [document], 2)
    expect((await store.listDocuments('memory'))[0]?.embeddingProfileFingerprint).toBe('profile-a')
    await expect(store.search('memory', [1, 0], 5, undefined, 'profile-b')).rejects.toThrow(/different embedding profile/)
    await expect(store.addDocuments('memory', [{ ...document, id: 'two', embeddingProfileFingerprint: 'profile-b' }], 2))
      .rejects.toThrow(/different embedding profile/)
    expect(await store.search('memory', [1, 0], 5, undefined, 'profile-a')).toHaveLength(1)
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('chunk keywords participate in BM25 while untagged chunks retain normal retrieval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cynosure-rag-tags-'))
  const store = new RAGStore()
  try {
    await store.initialize(directory)
    await store.addDocuments('memory', [
      {
        id: 'tagged', text: 'Chantal values having room to make her own decisions.',
        searchText: 'Chantal values having room to make her own decisions.', vector: [1, 0, 0],
        source: 'memory', sourceFile: 'chantal.md', chunkIndex: 0, folderId: 'persons',
        contentHash: 'chunk-a', createdAt: 1,
      },
      {
        id: 'untagged', text: 'Caroline works at Acme.', searchText: 'Caroline works at Acme.',
        vector: [0, 1, 0], source: 'memory', sourceFile: 'caroline.md', chunkIndex: 0,
        folderId: 'persons', contentHash: 'chunk-b', createdAt: 2,
      },
    ], 3)
    await store.rebuildFtsIndex('memory')
    expect(await store.lexicalSearch('memory', 'autonomy', 5)).toEqual([])

    const filter = andLanceDbFilters(
      lanceDbEqFilter('folderId', 'persons'),
      lanceDbEqFilter('sourceFile', 'chantal.md'),
    )!
    await expect(store.updateChunkSearchKeywords('memory', filter, new Map([
      [0, { contentHash: 'chunk-a', keywords: ['autonomy', 'relationship needs'] }],
    ]))).resolves.toBe(1)
    await store.rebuildFtsIndex('memory')

    expect((await store.lexicalSearch('memory', 'autonomy', 5))[0]?.id).toBe('tagged')
    expect((await store.lexicalSearch('memory', 'Caroline Acme', 5))[0]?.id).toBe('untagged')
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
