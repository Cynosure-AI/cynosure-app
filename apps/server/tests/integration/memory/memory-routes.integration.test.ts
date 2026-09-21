import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('memory search routes', () => {
  let directory = ''

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cynosure-memory-routes-'))
    process.env.CYNOSURE_DATA_DIR = directory
  })

  afterEach(async () => {
    const { closeDb } = await import('../../../src/db/database.js')
    closeDb()
    delete process.env.CYNOSURE_DATA_DIR
    await rm(directory, { recursive: true, force: true })
  })

  async function createApp() {
    const { registerMemoryRoutes } = await import('../../../src/routes/memory.js')
    const app = Fastify()
    await app.register(async (instance) => registerMemoryRoutes(instance, () => undefined), { prefix: '/api/memory' })
    return app
  }

  test('rejects empty queries before invoking an embedding provider', async () => {
    const app = await createApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/memory/search',
      payload: { query: '   ', topK: 5 },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'A non-empty search query is required' })
    await app.close()
  }, 30_000)

  test('fails closed when an explicit memory folder does not exist', async () => {
    const app = await createApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/memory/search',
      payload: { query: 'project dependencies', folderId: 'missing-space' },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: 'Memory folder not found' })
    await app.close()
  })

  test('drops knowledge-v2 vectors and marks their projections pending', async () => {
    const { getRAGStore } = await import('../../../src/core/memory/rag.js')
    const { getMemoryKnowledgeStore, MEMORY_KNOWLEDGE_VECTOR_TABLE } = await import('../../../src/core/memory/memory-knowledge.js')
    const rag = getRAGStore()
    const knowledge = getMemoryKnowledgeStore()
    const deleteTable = vi.spyOn(rag, 'deleteTable').mockResolvedValue(undefined)
    const markPending = vi.spyOn(knowledge, 'markSearchProjectionsPending')
    const app = await createApp()

    const response = await app.inject({ method: 'POST', url: '/api/memory/embeddings/drop' })

    expect(response.statusCode).toBe(200)
    expect(deleteTable).toHaveBeenCalledWith(MEMORY_KNOWLEDGE_VECTOR_TABLE)
    expect(markPending).toHaveBeenCalledOnce()
    await app.close()
  })

  test('serves the canonical cross-boundary limits the web client renders', async () => {
    const { MEMORY_LIMITS } = await import('../../../src/core/runtime-limits.js')
    const app = await createApp()

    const response = await app.inject({ method: 'GET', url: '/api/memory/limits' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(MEMORY_LIMITS)
    // The analysis limit is the one that previously drifted between the web
    // MAX_ANALYSIS_CHUNKS literal and the server MAX_DEEP_RESEARCH_CHUNKS one.
    expect(response.json().analysisChunkLimit).toBe(MEMORY_LIMITS.analysisChunkLimit)
    await app.close()
  })

  test('deletes a literal fact-value node instead of treating it as an entity', async () => {
    const { getDb } = await import('../../../src/db/database.js')
    const { getMemoryKnowledgeStore } = await import('../../../src/core/memory/memory-knowledge.js')
    const db = getDb()
    const now = Date.now()
    db.prepare(`
      INSERT INTO memory_folders (id, name, description, directory_path, sort_order, is_uncategorized, created_at)
      VALUES ('medical', 'Medical', '', ?, 1, 0, ?)
    `).run(directory, now)
    db.prepare(`
      INSERT INTO memory_file_index
        (document_id, document_ref, category_id, file_name, content_hash, chunk_count,
         last_indexed_at, deep_researched_at, created_at)
      VALUES ('doc-medical', 'doc-medical-ref', 'medical', 'medical.md', 'revision-1', 1, ?, 0, ?)
    `).run(now, now)
    const value = 'HNO-Vorstellung zur Bestätigung des paroxysmalen neuronalen Tinnitus-Charakters, Ausschluss struktureller Ursachen und Beratung zu medikamentöser Testung (z. B. Carbamazepin) oder weiterer Diagnostik (MRT nur bei zusätzlichen Symptomen)'
    const knowledge = getMemoryKnowledgeStore()
    knowledge.publishDocument({
      documentId: 'doc-medical', contentHash: 'revision-1', folderId: 'medical',
      fileName: 'medical.md', sourceId: 'memory:medical:medical.md',
      chunks: [{ text: value, searchText: value, chunkIndex: 0, documentTitle: 'Medical', sectionPath: '', contentHash: 'chunk-1' }],
      relations: [{
        from: { name: 'Patient', type: 'person' }, relation: 'next_step', objectValue: value,
        sourceChunkIndex: 0, note: value,
      }],
    })
    const literal = knowledge.browseGraph({ folderIds: ['medical'] }).nodes.find((node) => node.id.startsWith('literal:'))
    expect(literal?.name).toBe(value)
    const assertionId = literal!.id.slice('literal:'.length)
    const app = await createApp()

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/memory/knowledge/graph/nodes/${encodeURIComponent(literal!.id)}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ success: true })
    expect(knowledge.getEdge(assertionId)).toBeNull()
    await app.close()
  })
})
