import type { FastifyInstance } from 'fastify'
import { getAgentMemory } from '../core/memory/agent-memory.js'
import { getMemoryAggregator } from '../core/memory/memory-aggregator.js'
import { getHistoryStore } from '../core/memory/history.js'
import { getEmbeddingProvider } from '../core/memory/embedding.js'
import { getMemoryParser } from '../core/memory/parser.js'
import { getMemoryReranker, type MemoryRerankerConfig } from '../core/memory/reranker.js'
import { getRAGStore } from '../core/memory/rag.js'
import { buildMemorySpaceFilter, getAllMemorySpaces } from '../core/memory/memory-space-scope.js'
import { getEntityGraphStore, type EntityType } from '../core/memory/entity-graph.js'
import { getDb } from '../db/database.js'
import { getGateway } from '../core/gateway/gateway.js'
import OpenAI from 'openai'
import { GoogleGenAI } from '@google/genai'

type BroadcastFn = (event: string, data: unknown) => void

async function detectEmbeddingDimensions(providerId: string | undefined, model: string): Promise<number> {
  const provider = providerId
    ? getGateway().getProvider(providerId)
    : getGateway().getLastUsedProvider()
  if (!provider) throw new Error('Provider not found')

  if (provider.config.type === 'google') {
    const client = new GoogleGenAI({ apiKey: provider.config.apiKey || 'not-set' })
    const res = await client.models.embedContent({
      model,
      contents: 'test'
    })
    const dimensions = res.embeddings?.[0]?.values?.length || 0
    if (!dimensions) throw new Error('Embedding response did not include vector values')
    return dimensions
  }

  const client = new OpenAI({
    baseURL: provider.config.baseUrl,
    apiKey: provider.config.apiKey || 'no-key'
  })
  const res = await client.embeddings.create({ model, input: 'test' })
  const dimensions = res.data[0].embedding.length
  if (!dimensions) throw new Error('Embedding response did not include vector values')
  return dimensions
}

export async function registerMemoryRoutes(app: FastifyInstance, broadcast: BroadcastFn): Promise<void> {
  // POST /api/memory/search — search permanent memory
  app.post<{ Body: { query: string; topK?: number; spaceId?: string } }>('/search', async (req) => {
    const { query, topK, spaceId } = req.body
    const mem = getAgentMemory()
    let filter: string | undefined

    if (spaceId?.trim()) {
      const db = getDb()
      const row = db
        .prepare('SELECT id, name FROM memory_spaces WHERE id = ?')
        .get(spaceId.trim()) as { id: string; name: string } | undefined
      filter = row ? buildMemorySpaceFilter([row]) : undefined
    } else {
      filter = buildMemorySpaceFilter(getAllMemorySpaces())
    }

    return mem.recall(query, topK, filter)
  })

  // POST /api/memory/entries/delete — delete entries by IDs
  app.post<{ Body: { ids: string[] } }>('/entries/delete', async (req) => {
    const { ids } = req.body
    if (!ids?.length) return { success: false, error: 'No IDs provided' }
    const rag = getRAGStore()
    await rag.deleteByIds('permanent_memory', ids)
    return { success: true, deleted: ids.length }
  })

  // POST /api/memory/aggregate — aggregated search
  app.post<{
    Body: { query: string; opts?: { taskId?: string; conversationId?: string; agentId?: string; spaceIds?: string[] } }
  }>('/aggregate', async (req) => {
    const { query, opts } = req.body
    const aggregator = getMemoryAggregator()
    const memory = await aggregator.aggregate(query, opts)
    return {
      permanent: memory.permanent,
      graph: memory.graph,
      formatted: aggregator.format(memory)
    }
  })

  // GET /api/memory/graph — inspect the lightweight entity graph
  app.get<{ Querystring: { query?: string; limit?: string } }>('/graph', async (req) => {
    const graph = getEntityGraphStore()
    const limit = Math.min(Math.max(Number(req.query.limit) || 80, 1), 200)
    const query = req.query.query?.trim()
    if (query) {
      const seeds = graph.findSeedNodes(query, [], 12)
      const walk = graph.walk(seeds.map((node) => node.id), 2, limit)
      return {
        stats: graph.stats(),
        seedNodes: walk.seedNodes,
        nodes: walk.nodes,
        edges: walk.edges
      }
    }
    return {
      stats: graph.stats(),
      seedNodes: [],
      ...graph.list(limit)
    }
  })

  // GET /api/memory/graph/suggestions — autocomplete entity names
  app.get<{ Querystring: { query?: string; limit?: string } }>('/graph/suggestions', async (req) => {
    const graph = getEntityGraphStore()
    const limit = Math.min(Math.max(Number(req.query.limit) || 8, 1), 20)
    return {
      suggestions: graph.suggestNodes(req.query.query?.trim() || '', limit)
    }
  })

  // PATCH /api/memory/graph/nodes/:id — manually correct an entity node
  app.patch<{
    Params: { id: string }
    Body: { name?: string; type?: string; aliases?: string[] }
  }>('/graph/nodes/:id', async (req, reply) => {
    const name = req.body.name?.trim()
    if (name !== undefined && name.length === 0) {
      return reply.status(400).send({ error: 'Entity name cannot be empty' })
    }

    try {
      const updated = getEntityGraphStore().updateNode(req.params.id, {
        name,
        type: req.body.type as EntityType | undefined,
        aliases: Array.isArray(req.body.aliases) ? req.body.aliases : undefined
      })
      if (!updated) return reply.status(404).send({ error: 'Entity not found' })
      return updated
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message === 'ENTITY_NODE_CONFLICT') {
        return reply.status(409).send({ error: 'An entity with that name already exists' })
      }
      if (message === 'ENTITY_NODE_INVALID_NAME') {
        return reply.status(400).send({ error: 'Entity name is not valid' })
      }
      throw error
    }
  })

  // DELETE /api/memory/graph/nodes/:id — manually remove an entity and its relationships
  app.delete<{ Params: { id: string } }>('/graph/nodes/:id', async (req, reply) => {
    const deleted = getEntityGraphStore().deleteNode(req.params.id)
    if (!deleted) return reply.status(404).send({ error: 'Entity not found' })
    return { success: true }
  })

  // PATCH /api/memory/graph/edges/:id — manually correct a relationship
  app.patch<{
    Params: { id: string }
    Body: { relation?: string; evidence?: string; confidence?: number }
  }>('/graph/edges/:id', async (req, reply) => {
    const relation = req.body.relation?.trim()
    if (relation !== undefined && relation.length === 0) {
      return reply.status(400).send({ error: 'Relation cannot be empty' })
    }
    const updated = getEntityGraphStore().updateEdge(req.params.id, {
      relation,
      evidence: req.body.evidence,
      confidence: req.body.confidence
    })
    if (!updated) return reply.status(404).send({ error: 'Relationship not found' })
    return updated
  })

  // DELETE /api/memory/graph/edges/:id — manually remove a relationship
  app.delete<{ Params: { id: string } }>('/graph/edges/:id', async (req, reply) => {
    const result = getEntityGraphStore().deleteEdge(req.params.id)
    if (!result.edgeDeleted) return reply.status(404).send({ error: 'Relationship not found' })
    return { success: true, orphanedNodeIds: result.orphanedNodeIds }
  })

  // DELETE /api/memory/graph — clear all entity graph nodes and relationships
  app.delete('/graph', async () => {
    const deleted = getEntityGraphStore().deleteAll()
    return { success: true, ...deleted }
  })

  // GET /api/memory/history/:conversationId — get history
  app.get<{ Params: { conversationId: string } }>(
    '/history/:conversationId',
    async (req) => {
      const history = getHistoryStore()
      return history.getThread(req.params.conversationId)
    }
  )

  // POST /api/memory/embeddings/configure — configure embeddings
  app.post<{
    Body: { providerId?: string; baseUrl?: string; apiKey?: string; model?: string; dimensions?: number; reembed?: boolean }
  }>('/embeddings/configure', async (req) => {
    const embedder = getEmbeddingProvider()
    const oldConfig = embedder.getConfig()
    const { reembed, ...configOpts } = req.body

    const newModel = configOpts.model || oldConfig.model
    const newProviderId = configOpts.providerId ?? oldConfig.providerId
    const newDimensions = configOpts.dimensions || await detectEmbeddingDimensions(newProviderId, newModel || 'text-embedding-3-small')
    const resolvedConfig = { ...configOpts, model: newModel, dimensions: newDimensions }
    const embeddingChanged =
      oldConfig.providerId !== newProviderId ||
      oldConfig.model !== newModel ||
      oldConfig.dimensions !== newDimensions

    if (embeddingChanged && reembed) {
      // Re-embed flow: read all existing chunks → configure new provider → drop → re-embed → write back
      const rag = getRAGStore()
      const existingDocs = await rag.listDocuments('permanent_memory')
      const chunksToReembed = existingDocs.filter(d => d.id !== '__seed__')

      // Configure new provider FIRST so embedBatch uses the new model
      embedder.configure(resolvedConfig)

      // Drop old table (incompatible dimensions)
      await rag.deleteTable('permanent_memory')

      if (chunksToReembed.length > 0) {
        // Re-embed in batches
        const BATCH_SIZE = 32
        let totalReembedded = 0
        const totalChunks = chunksToReembed.length

        broadcast('memory:reembed-progress', { current: 0, total: totalChunks, status: 'started' })

        for (let i = 0; i < chunksToReembed.length; i += BATCH_SIZE) {
          const batch = chunksToReembed.slice(i, i + BATCH_SIZE)
          const texts = batch.map(d => d.text)

          try {
            const embeddings = await embedder.embedBatch(texts)
            const docs = batch.map((doc, j) => ({
              id: doc.id,
              text: doc.text,
              vector: embeddings[j].vector,
              source: doc.source,
              sourceFile: doc.sourceFile || '',
              chunkIndex: doc.chunkIndex ?? 0,
              spaceId: doc.spaceId || '',
              createdAt: doc.createdAt
            }))
            await rag.addDocuments('permanent_memory', docs, newDimensions)
            totalReembedded += docs.length
            broadcast('memory:reembed-progress', { current: totalReembedded, total: totalChunks, status: 'in-progress' })
          } catch (err) {
            console.error(`[reembed] Batch failed at offset ${i}:`, err)
            // Continue with remaining batches
          }
        }

        broadcast('memory:reembed-progress', { current: totalReembedded, total: totalChunks, status: 'completed' })
        return { success: true, vectorsDropped: false, reembedded: true, reembeddedCount: totalReembedded, dimensions: newDimensions }
      }

      return { success: true, vectorsDropped: false, reembedded: true, reembeddedCount: 0, dimensions: newDimensions }
    }

    embedder.configure(resolvedConfig)

    if (embeddingChanged) {
      const rag = getRAGStore()
      await rag.deleteTable('permanent_memory')
    }

    return { success: true, vectorsDropped: embeddingChanged, reembedded: false, reembeddedCount: 0, dimensions: newDimensions }
  })

  // GET /api/memory/embeddings/config — get current embedding config
  app.get('/embeddings/config', async () => {
    const embedder = getEmbeddingProvider()
    return embedder.getConfig()
  })

  // POST /api/memory/embeddings/drop — drop all vector data
  app.post('/embeddings/drop', async () => {
    const rag = getRAGStore()
    await rag.deleteTable('permanent_memory')
    getDb().prepare('DELETE FROM memory_file_index').run()
    return { success: true }
  })

  // POST /api/memory/embeddings/probe — test-embed a token to detect output dimensions
  app.post<{
    Body: { providerId?: string; model: string }
  }>('/embeddings/probe', async (req, reply) => {
    const { providerId, model } = req.body
    try {
      return { dimensions: await detectEmbeddingDimensions(providerId, model) }
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message })
    }
  })

  // GET /api/memory/chunking/config — get chunking config
  app.get('/chunking/config', async () => {
    const parser = getMemoryParser()
    return parser.getConfig()
  })

  // POST /api/memory/chunking/configure — set chunking config
  app.post<{
    Body: { chunkSize: number; chunkOverlap: number }
  }>('/chunking/configure', async (req, reply) => {
    const { chunkSize, chunkOverlap } = req.body
    if (!chunkSize || chunkSize < 64 || chunkSize > 4096) {
      return reply.status(400).send({ error: 'chunkSize must be between 64 and 4096 tokens' })
    }
    if (chunkOverlap === undefined || chunkOverlap < 0 || chunkOverlap >= chunkSize) {
      return reply.status(400).send({ error: 'chunkOverlap must be >= 0 and < chunkSize' })
    }
    const db = getDb()
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value_json) VALUES ('chunking', ?)"
    ).run(JSON.stringify({ chunkSize, chunkOverlap }))
    const parser = getMemoryParser()
    parser.refreshConfig()
    return { success: true, chunkSize, chunkOverlap }
  })

  // GET /api/memory/parser/config — get document parser config (OCR etc.)
  app.get('/parser/config', async () => {
    const db = getDb()
    const row = db.prepare("SELECT value_json FROM settings WHERE key = 'documentParser'").get() as { value_json: string } | undefined
    if (row) {
      const cfg = JSON.parse(row.value_json) as { ocrEnabled: boolean; ocrLanguage?: string }
      return { ocrEnabled: cfg.ocrEnabled, ocrLanguage: cfg.ocrLanguage || 'eng' }
    }
    return { ocrEnabled: false, ocrLanguage: 'eng' }
  })

  // POST /api/memory/parser/configure — set document parser config
  app.post<{ Body: { ocrEnabled: boolean; ocrLanguage?: string } }>('/parser/configure', async (req) => {
    const { ocrEnabled, ocrLanguage } = req.body
    const lang = (ocrLanguage || 'eng').trim()
    const db = getDb()
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value_json) VALUES ('documentParser', ?)"
    ).run(JSON.stringify({ ocrEnabled: !!ocrEnabled, ocrLanguage: lang }))
    return { success: true, ocrEnabled: !!ocrEnabled, ocrLanguage: lang }
  })

  // GET /api/memory/reranker/config — get optional external reranker config
  app.get('/reranker/config', async () => {
    return getMemoryReranker().getConfig()
  })

  // POST /api/memory/reranker/configure — enable/configure OpenRouter reranking
  app.post<{ Body: Partial<MemoryRerankerConfig> }>('/reranker/configure', async (req, reply) => {
    if (req.body.enabled && req.body.providerId) {
      const provider = getGateway().getProvider(req.body.providerId)
      if (!provider) return reply.status(400).send({ error: 'Reranker provider not found' })
      if (provider.config.type !== 'openrouter') {
        return reply.status(400).send({ error: 'Reranking currently requires an OpenRouter provider' })
      }
    }

    const config = getMemoryReranker().saveConfig(req.body)
    return { success: true, ...config }
  })
}
