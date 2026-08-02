import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RAGStore } from './rag.js'

test('hybrid search retains LanceDB fusion scores for lexical candidates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cynosure-rag-'))
  const store = new RAGStore()
  try {
    await store.initialize(directory)
    await store.addDocuments('memory', [
      { id: 'semantic', text: 'general deployment guidance', vector: [1, 0, 0], source: 'test', createdAt: 1 },
      { id: 'lexical', text: 'ExactCode-ZX91 troubleshooting procedure', vector: [0, 1, 0], source: 'test', createdAt: 2 },
      { id: 'other', text: 'unrelated gardening notes', vector: [0, 0, 1], source: 'test', createdAt: 3 },
    ], 3)
    await store.rebuildFtsIndex('memory')

    const results = await store.hybridSearch('memory', [1, 0, 0], 'ExactCode-ZX91', 3)
    const lexical = results.find((item) => item.id === 'lexical')
    assert.ok(lexical)
    assert.equal(lexical.scoreType, 'fusion')
    assert.equal(lexical.score, lexical.fusionScore)
    assert.ok((lexical.fusionScore ?? 0) > 0)

  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
