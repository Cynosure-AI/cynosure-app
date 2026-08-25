import { expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RAGStore } from '../../../src/core/memory/rag.js'
import { andLanceDbFilters, lanceDbEqFilter } from '../../../src/core/memory/lancedb-filter.js'

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

test('chunk keywords participate in BM25 while untagged chunks retain normal retrieval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cynosure-rag-tags-'))
  const store = new RAGStore()
  try {
    await store.initialize(directory)
    await store.addDocuments('memory', [
      {
        id: 'tagged', text: 'Chantal values having room to make her own decisions.',
        searchText: 'Chantal values having room to make her own decisions.', vector: [1, 0, 0],
        source: 'memory', sourceFile: 'chantal.md', chunkIndex: 0, spaceId: 'persons',
        contentHash: 'chunk-a', createdAt: 1,
      },
      {
        id: 'untagged', text: 'Caroline works at Acme.', searchText: 'Caroline works at Acme.',
        vector: [0, 1, 0], source: 'memory', sourceFile: 'caroline.md', chunkIndex: 0,
        spaceId: 'persons', contentHash: 'chunk-b', createdAt: 2,
      },
    ], 3)
    await store.rebuildFtsIndex('memory')
    expect(await store.lexicalSearch('memory', 'autonomy', 5)).toEqual([])

    const filter = andLanceDbFilters(
      lanceDbEqFilter('spaceId', 'persons'),
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
