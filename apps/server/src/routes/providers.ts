import type { FastifyInstance } from 'fastify'
import { getDb } from '../db/database.js'
import { getGateway } from '../core/gateway/gateway.js'
import type { LLMProviderConfig, ModelListType, TranscriptionRequest, VideoGenerationRequest } from '../core/gateway/providers/base.provider.js'
import { nanoid } from 'nanoid'

/** Load providers from DB into the gateway (called once at startup) */
export function loadSavedProviders(): void {
  const gateway = getGateway()
  const db = getDb()
  const rows = db.prepare('SELECT * FROM providers ORDER BY created_at').all() as {
    id: string
    config_json: string
    api_key_enc: string | null
    is_last_used: number
  }[]

  let defaultId: string | null = null
  for (const row of rows) {
    const config = JSON.parse(row.config_json) as LLMProviderConfig
    // api_key_enc is now stored in plaintext (was safeStorage-encrypted in Electron)
    if (row.api_key_enc) {
      config.apiKey = row.api_key_enc
    }
    try {
      gateway.registerProvider(config)
      if (row.is_last_used === 1) defaultId = row.id
    } catch {
      // Skip invalid providers
    }
  }
  // Restore the persisted default provider (overrides the first-registered fallback)
  if (defaultId) gateway.setLastUsedProvider(defaultId)
}

export async function registerProviderRoutes(app: FastifyInstance): Promise<void> {
  const gateway = getGateway()

  // GET /api/providers — list all providers
  app.get('/', async () => {
    const db = getDb()
    const rows = db.prepare('SELECT * FROM providers ORDER BY created_at').all() as {
      id: string
      name: string
      type: string
      base_url: string
      api_key_enc: string | null
      default_model: string
      config_json: string
    }[]

    return rows.map((row) => {
      const config = JSON.parse(row.config_json) as LLMProviderConfig
      if (row.api_key_enc) {
        config.apiKey = row.api_key_enc
      }
      return config
    })
  })

  // POST /api/providers — add a provider
  app.post<{ Body: LLMProviderConfig }>('/', async (req) => {
    const config = req.body
    const db = getDb()
    const id = config.id || nanoid()
    config.id = id

    // Store API key separately
    const apiKeyPlain: string | null = config.apiKey || null
    const configForStorage = { ...config, apiKey: undefined }
    const now = Date.now()

    db.prepare(
      `INSERT OR REPLACE INTO providers (id, name, type, base_url, api_key_enc, default_model, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, config.name, config.type, config.baseUrl, apiKeyPlain, config.defaultModel, JSON.stringify(configForStorage), now, now)

    gateway.registerProvider(config)
    return { id }
  })

  // DELETE /api/providers/:id — remove a provider
  app.delete<{ Params: { id: string } }>('/:id', async (req) => {
    const db = getDb()
    db.prepare('DELETE FROM providers WHERE id = ?').run(req.params.id)
    gateway.removeProvider(req.params.id)
    return { success: true }
  })

  // PUT /api/providers/active — set last-used provider (persisted as is_last_used in DB)
  app.put<{ Body: { id: string } }>('/active', async (req) => {
    const db = getDb()
    db.prepare('UPDATE providers SET is_last_used = 0').run()
    db.prepare('UPDATE providers SET is_last_used = 1 WHERE id = ?').run(req.body.id)
    gateway.setLastUsedProvider(req.body.id)
    return { success: true }
  })

  // GET /api/providers/active — get active provider id
  app.get('/active', async () => {
    return { id: gateway.getLastUsedProviderId() }
  })

  // POST /api/providers/:id/test — test connection
  app.post<{ Params: { id: string } }>('/:id/test', async (req) => {
    try {
      const ok = await gateway.testConnection(req.params.id)
      return { success: ok }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // GET /api/providers/:id/models — list models
  app.get<{ Params: { id: string }; Querystring: { type?: ModelListType; details?: string } }>('/:id/models', async (req, reply) => {
    try {
      if (req.query.details === 'true') {
        return await gateway.listModelItems(req.params.id, req.query.type)
      }
      const models = await gateway.listModels(req.params.id, req.query.type)
      return models
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message })
    }
  })

  // POST /api/providers/:id/transcriptions — transcribe a base64 audio payload
  app.post<{ Params: { id: string }; Body: TranscriptionRequest }>('/:id/transcriptions', async (req, reply) => {
    try {
      const result = await gateway.transcribeAudio(req.body, req.params.id)
      return result
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message })
    }
  })

  // GET /api/providers/:id/models/:model/info — get model metadata (context length etc.)
  app.get<{ Params: { id: string; model: string } }>('/:id/models/:model/info', async (req, reply) => {
    try {
      const info = await gateway.getModelInfo(decodeURIComponent(req.params.model), req.params.id)
      return info
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message })
    }
  })

  // GET /api/providers/:id/videos/models — list video generation models with capabilities
  app.get<{ Params: { id: string } }>('/:id/videos/models', async (req, reply) => {
    try {
      const models = await gateway.listVideoModels(req.params.id)
      return models
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message })
    }
  })

  // POST /api/providers/:id/videos — submit an async video generation job
  app.post<{ Params: { id: string }; Body: VideoGenerationRequest }>('/:id/videos', async (req, reply) => {
    try {
      const job = await gateway.generateVideo(req.body, req.params.id)
      return reply.status(202).send(job)
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message })
    }
  })

  // GET /api/providers/:id/videos/:jobId/content?index=0 — download generated video content
  app.get<{ Params: { id: string; jobId: string }; Querystring: { index?: string } }>('/:id/videos/:jobId/content', async (req, reply) => {
    try {
      const index = Number.parseInt(req.query.index || '0', 10)
      const content = await gateway.getVideoGenerationContent(
        decodeURIComponent(req.params.jobId),
        Number.isFinite(index) ? index : 0,
        req.params.id
      )
      return reply.type(content.contentType).send(Buffer.from(content.data))
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message })
    }
  })

  // GET /api/providers/:id/videos/:jobId — poll an async video generation job
  app.get<{ Params: { id: string; jobId: string } }>('/:id/videos/:jobId', async (req, reply) => {
    try {
      const job = await gateway.getVideoGenerationJob(decodeURIComponent(req.params.jobId), req.params.id)
      return job
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message })
    }
  })
}
