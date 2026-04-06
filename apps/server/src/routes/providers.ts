import type { FastifyInstance } from 'fastify'
import { getDb } from '../db/database.js'
import { getGateway } from '../core/gateway/gateway.js'
import type { LLMProviderConfig } from '../core/gateway/providers/base.provider.js'
import { nanoid } from 'nanoid'

/** Load providers from DB into the gateway (called once at startup) */
export function loadSavedProviders(): void {
  const gateway = getGateway()
  const db = getDb()
  const rows = db.prepare('SELECT * FROM providers ORDER BY created_at').all() as {
    id: string
    config_json: string
    api_key_enc: string | null
  }[]

  for (const row of rows) {
    const config = JSON.parse(row.config_json) as LLMProviderConfig
    // api_key_enc is now stored in plaintext (was safeStorage-encrypted in Electron)
    if (row.api_key_enc) {
      config.apiKey = row.api_key_enc
    }
    try {
      gateway.registerProvider(config)
    } catch {
      // Skip invalid providers
    }
  }
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

  // PUT /api/providers/active — set active provider
  app.put<{ Body: { id: string } }>('/active', async (req) => {
    gateway.setActiveProvider(req.body.id)
    return { success: true }
  })

  // GET /api/providers/active — get active provider id
  app.get('/active', async () => {
    return { id: gateway.getActiveProviderId() }
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
  app.get<{ Params: { id: string }; Querystring: { type?: 'llm' | 'embedding' } }>('/:id/models', async (req, reply) => {
    try {
      const models = await gateway.listModels(req.params.id, req.query.type)
      return models
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message })
    }
  })
}
