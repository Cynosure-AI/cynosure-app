import { expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('an assertion survives until its final active evidence source is retired', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cynosure-knowledge-'))
  process.env.CYNOSURE_DATA_DIR = directory
  const { closeDb, getDb } = await import('../../../src/db/database.js')
  const { MemoryKnowledgeStore } = await import('../../../src/core/memory/memory-knowledge.js')
  try {
    const db = getDb()
    db.prepare(`INSERT INTO memory_spaces (id, name, description, folder_path, created_at) VALUES ('space-a', 'A', '', ?, ?)`)
      .run(directory, Date.now())
    const store = new MemoryKnowledgeStore()
    const relation = [{
      from: { name: 'Cynosure', type: 'project' as const }, relation: 'uses',
      to: { name: 'LanceDB', type: 'technology' as const }, sourceChunkIndex: 0,
      note: 'Cynosure uses LanceDB.', importance: 2 as const,
    }]
    for (const documentId of ['doc-a', 'doc-b']) {
      db.prepare(`INSERT INTO memory_file_index (document_id, document_ref, space_id, file_name, content_hash, created_at) VALUES (?, ?, 'space-a', ?, 'revision-1', ?)`)
        .run(documentId, `ref-${documentId}`, `${documentId}.md`, Date.now())
      store.publishDocument({
        documentId, contentHash: 'revision-1', spaceId: 'space-a', fileName: `${documentId}.md`,
        sourceId: `memory:space-a:${documentId}.md`,
        chunks: [{ text: 'Cynosure uses LanceDB.', searchText: 'Cynosure uses LanceDB.', chunkIndex: 0, documentTitle: 'Architecture', sectionPath: 'Architecture', contentHash: `${documentId}-chunk` }],
        relations: relation,
      })
    }

    const edge = store.browseGraph({ spaceIds: ['space-a'] }).edges[0]
    expect((db.prepare(`SELECT COUNT(*) AS count FROM memory_knowledge_assertion_evidence WHERE assertion_id = ?`).get(edge.id) as { count: number }).count).toBe(2)
    store.retireDocument('doc-b')
    expect(store.getEdge(edge.id)).not.toBeNull()
    store.retireDocument('doc-a')
    expect(store.getEdge(edge.id)).toBeNull()
  } finally {
    closeDb()
    delete process.env.CYNOSURE_DATA_DIR
    await rm(directory, { recursive: true, force: true })
  }
})
