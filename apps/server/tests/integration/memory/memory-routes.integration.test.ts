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

  test('fails closed when an explicit memory category does not exist', async () => {
    const app = await createApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/memory/search',
      payload: { query: 'project dependencies', categoryId: 'missing-space' },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: 'Memory category not found' })
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
})
