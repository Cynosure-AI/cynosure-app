import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
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
  })

  test('fails closed when an explicit memory space does not exist', async () => {
    const app = await createApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/memory/search',
      payload: { query: 'project dependencies', spaceId: 'missing-space' },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: 'Memory space not found' })
    await app.close()
  })
})
