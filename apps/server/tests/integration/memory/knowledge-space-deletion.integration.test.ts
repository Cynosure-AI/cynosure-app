import { expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('deleting one memory-space knowledge projection leaves other spaces intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cynosure-knowledge-space-'))
  process.env.CYNOSURE_DATA_DIR = directory
  const { closeDb, getDb } = await import('../../../src/db/database.js')
  const { MemoryKnowledgeStore } = await import('../../../src/core/memory/memory-knowledge.js')
  const { deleteMemoryKnowledgeSpace } = await import('../../../src/core/memory/memory-knowledge-extraction.js')
  try {
    const db = getDb()
    const store = new MemoryKnowledgeStore()
    for (const spaceId of ['space-a', 'space-b']) {
      db.prepare(`INSERT INTO memory_spaces (id, name, description, folder_path, created_at) VALUES (?, ?, '', ?, ?)`)
        .run(spaceId, spaceId, directory, Date.now())
      const documentId = `doc-${spaceId}`
      db.prepare(`INSERT INTO memory_file_index (document_id, document_ref, space_id, file_name, content_hash, created_at) VALUES (?, ?, ?, 'architecture.md', 'revision-1', ?)`)
        .run(documentId, `ref-${spaceId}`, spaceId, Date.now())
      store.publishDocument({
        documentId, contentHash: 'revision-1', spaceId, fileName: 'architecture.md',
        sourceId: `memory:${spaceId}:architecture.md`,
        chunks: [{ text: 'Cynosure uses LanceDB.', searchText: 'Cynosure uses LanceDB.', chunkIndex: 0, documentTitle: 'Architecture', sectionPath: 'Architecture', contentHash: `${spaceId}-chunk` }],
        relations: [{ from: { name: 'Cynosure', type: 'project' }, relation: 'uses', to: { name: 'LanceDB', type: 'technology' }, sourceChunkIndex: 0 }],
      })
    }

    expect(store.browseGraph({ spaceIds: ['space-a'] }).edges).toHaveLength(1)
    expect(store.browseGraph({ spaceIds: ['space-b'] }).edges).toHaveLength(1)
    expect(deleteMemoryKnowledgeSpace('space-a').edgesDeleted).toBe(1)
    expect(store.browseGraph({ spaceIds: ['space-a'] }).edges).toHaveLength(0)
    expect(store.browseGraph({ spaceIds: ['space-b'] }).edges).toHaveLength(1)
  } finally {
    closeDb()
    delete process.env.CYNOSURE_DATA_DIR
    await rm(directory, { recursive: true, force: true })
  }
})
