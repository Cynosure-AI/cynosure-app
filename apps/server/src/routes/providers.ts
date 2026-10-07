import type { FastifyInstance } from 'fastify'
import { getDb } from '../db/database.js'
import { getGateway } from '../core/gateway/gateway.js'
import type { LLMProviderConfig, ModelListType, TranscriptionRequest, VideoGenerationRequest } from '../core/gateway/providers/base.provider.js'
import { nanoid } from 'nanoid'

const PROVIDER_TYPES = new Set<LLMProviderConfig['type']>([
  'openai', 'anthropic', 'google', 'lmstudio', 'grok', 'ollama', 'openrouter', 'requesty', 'groq', 'mistral', 'unsloth'
])
/** Local servers take a user-supplied base URL. */
const LOCAL_PROVIDER_TYPES = new Set<LLMProviderConfig['type']>(['lmstudio', 'ollama', 'unsloth'])
/** Local servers that run without authentication; every other provider needs a key. */
const KEYLESS_PROVIDER_TYPES = new Set<LLMProviderConfig['type']>(['lmstudio', 'ollama'])
const MODEL_LIST_TYPES = new Set<ModelListType>(['llm', 'embedding', 'image', 'video', 'transcription'])

type ProviderConfigResult = { config: LLMProviderConfig } | { error: string }

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Validate a provider config from a request body. `requireModel` is false for
 * model previews, where the user has not picked a default model yet.
 */
export function parseProviderConfig(body: unknown, { requireModel = true } = {}): ProviderConfigResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Provider config must be an object.' }
  const input = body as Record<string, unknown>
  const type = input.type as LLMProviderConfig['type']
  if (!PROVIDER_TYPES.has(type)) return { error: `Unknown provider type: ${String(input.type)}` }

  const name = optionalString(input.name)
  const defaultModel = optionalString(input.defaultModel)
  const apiKey = optionalString(input.apiKey)
  const baseUrl = optionalString(input.baseUrl)
  if (requireModel && !name) return { error: 'Provider name is required.' }
  if (requireModel && !defaultModel) return { error: 'Default model is required.' }
  if (!KEYLESS_PROVIDER_TYPES.has(type) && !apiKey) return { error: 'An API key is required for this provider.' }
  if (LOCAL_PROVIDER_TYPES.has(type) && !baseUrl) return { error: 'A base URL is required for local providers.' }
  if (baseUrl) {
    try {
      const protocol = new URL(baseUrl).protocol
      if (protocol !== 'http:' && protocol !== 'https:') return { error: 'Base URL must start with http:// or https://.' }
    } catch {
      return { error: 'Base URL is not a valid URL.' }
    }
  }

  return {
    config: {
      id: optionalString(input.id),
      name,
      type,
      baseUrl,
      apiKey: apiKey || undefined,
      defaultModel,
      availableModels: Array.isArray(input.availableModels)
        ? input.availableModels.filter((model): model is string => typeof model === 'string')
        : [],
      supportsStreaming: input.supportsStreaming !== false,
      supportsToolCalls: input.supportsToolCalls !== false,
      supportsVision: input.supportsVision === true,
    }
  }
}

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

  // POST /api/providers — add or update a provider
  app.post<{ Body: LLMProviderConfig }>('/', async (req, reply) => {
    const parsed = parseProviderConfig(req.body)
    if ('error' in parsed) return reply.status(400).send({ error: parsed.error })
    const config = parsed.config
    config.id ||= nanoid()

    // Build the client first so an unusable config is rejected before it is stored.
    try {
      gateway.createProvider(config)
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message })
    }

    const configForStorage = { ...config, apiKey: undefined }
    const now = Date.now()
    // Upsert instead of INSERT OR REPLACE: replacing deletes the row, which
    // would reset the creation order and the persisted default-provider flag.
    getDb().prepare(
      `INSERT INTO providers (id, name, type, base_url, api_key_enc, default_model, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         type = excluded.type,
         base_url = excluded.base_url,
         api_key_enc = excluded.api_key_enc,
         default_model = excluded.default_model,
         config_json = excluded.config_json,
         updated_at = excluded.updated_at`
    ).run(config.id, config.name, config.type, config.baseUrl, config.apiKey ?? null, config.defaultModel, JSON.stringify(configForStorage), now, now)

    gateway.registerProvider(config)
    return { id: config.id }
  })

  // POST /api/providers/models/preview — list models for a config that is not saved yet
  app.post<{ Body: { config?: unknown; types?: unknown } }>('/models/preview', async (req, reply) => {
    const parsed = parseProviderConfig(req.body?.config, { requireModel: false })
    if ('error' in parsed) return reply.status(400).send({ error: parsed.error })
    const requestedTypes = Array.isArray(req.body?.types) ? req.body.types : ['llm']
    const types = requestedTypes.filter((type): type is ModelListType => MODEL_LIST_TYPES.has(type as ModelListType))
    if (types.length === 0) return reply.status(400).send({ error: 'At least one valid model type is required.' })

    let provider
    try {
      provider = gateway.createProvider({ ...parsed.config, id: parsed.config.id || 'model-preview' })
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message })
    }
    try {
      const lists = await Promise.all(types.map((type) => provider.listModels(type)))
      return { models: Array.from(new Set(lists.flat())).sort() }
    } catch (err) {
      return reply.status(502).send({ error: (err as Error).message || 'The provider did not return a model list.' })
    }
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

  // GET /api/providers/:id/images/models — list image generation models with capabilities
  app.get<{ Params: { id: string } }>('/:id/images/models', async (req, reply) => {
    try {
      return await gateway.listImageGenerationModels(req.params.id)
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
