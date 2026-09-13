import * as lancedb from '@lancedb/lancedb'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { RAGStore } from './rag.js'

describe('RAG legacy category schema recovery', () => {
  let directory: string | undefined
  let store: RAGStore | undefined

  afterEach(async () => {
    await store?.close()
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  test('discards spaceId tables and signals that retained files need reindexing', async () => {
    directory = await mkdtemp(join(tmpdir(), 'cynosure-rag-legacy-'))
    const connection = await lancedb.connect(directory)
    await connection.createTable('permanent_memory', [{
      id: 'legacy',
      text: 'old vector data',
      vector: [0.1, 0.2],
      source: 'memory',
      sourceFile: 'Profile.md',
      chunkIndex: 0,
      spaceId: 'default',
      createdAt: Date.now(),
      searchText: 'old vector data',
      documentTitle: 'Profile',
      sectionPath: '',
      contentHash: 'hash',
      embeddingModel: 'legacy',
    }])
    connection.close()

    store = new RAGStore()
    await store.initialize(directory)

    expect(store.consumeLegacyCategorySchemaReset()).toBe(true)
    expect(store.consumeLegacyCategorySchemaReset()).toBe(false)

    const repairedConnection = await lancedb.connect(directory)
    expect(await repairedConnection.tableNames()).not.toContain('permanent_memory')
    repairedConnection.close()
  })
})
