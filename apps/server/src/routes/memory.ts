import type { FastifyInstance } from 'fastify'
import { getAgentMemory } from '../core/memory/agent-memory.js'
import { getMemoryAggregator } from '../core/memory/memory-aggregator.js'
import { getHistoryStore } from '../core/memory/history.js'
import { getEmbeddingProvider } from '../core/memory/embedding.js'
import { getMemoryParser } from '../core/memory/parser.js'
import { getRAGStore } from '../core/memory/rag.js'
import { getDb } from '../db/database.js'
import { getGateway } from '../core/gateway/gateway.js'
import OpenAI from 'openai'

type BroadcastFn = (event: string, data: unknown) => void

export async function registerMemoryRoutes(app: FastifyInstance, broadcast: BroadcastFn): Promise<void> {
  // POST /api/memory/search — search permanent memory
  app.post<{ Body: { query: string; topK?: number } }>('/search', async (req) => {
    const { query, topK } = req.body
    const mem = getAgentMemory()
    return mem.recall(query, topK)
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
    Body: { query: string; opts?: { taskId?: string; conversationId?: string } }
  }>('/aggregate', async (req) => {
    const { query, opts } = req.body
    const aggregator = getMemoryAggregator()
    const memory = await aggregator.aggregate(query, opts)
    return {
      permanent: memory.permanent,
      formatted: aggregator.format(memory)
    }
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

    // Check if model or dimensions changed
    const newModel = configOpts.model || oldConfig.model
    const newDimensions = configOpts.dimensions || oldConfig.dimensions || 1536
    const modelChanged = oldConfig.model !== newModel || oldConfig.dimensions !== newDimensions

    if (modelChanged && reembed) {
      // Re-embed flow: read all existing chunks → configure new provider → drop → re-embed → write back
      const rag = getRAGStore()
      const existingDocs = await rag.listDocuments('permanent_memory')
      const chunksToReembed = existingDocs.filter(d => d.id !== '__seed__')

      // Configure new provider FIRST so embedBatch uses the new model
      embedder.configure(configOpts)

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
        return { success: true, vectorsDropped: false, reembedded: true, reembeddedCount: totalReembedded }
      }

      return { success: true, vectorsDropped: false, reembedded: true, reembeddedCount: 0 }
    }

    embedder.configure(configOpts)

    if (modelChanged) {
      const rag = getRAGStore()
      await rag.deleteTable('permanent_memory')
    }

    return { success: true, vectorsDropped: modelChanged, reembedded: false, reembeddedCount: 0 }
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
    return { success: true }
  })

  // POST /api/memory/embeddings/probe — test-embed a token to detect output dimensions
  app.post<{
    Body: { providerId?: string; model: string }
  }>('/embeddings/probe', async (req, reply) => {
    const { providerId, model } = req.body
    try {
      let client: OpenAI
      if (providerId) {
        const provider = getGateway().getProvider(providerId)
        if (!provider) return reply.status(400).send({ error: 'Provider not found' })
        client = new OpenAI({
          baseURL: provider.config.baseUrl,
          apiKey: provider.config.apiKey || 'no-key'
        })
      } else {
        const provider = getGateway().getActiveProvider()
        client = new OpenAI({
          baseURL: provider.config.baseUrl,
          apiKey: provider.config.apiKey || 'no-key'
        })
      }
      const res = await client.embeddings.create({ model, input: 'test' })
      const dimensions = res.data[0].embedding.length
      return { dimensions }
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
    if (!chunkSize || chunkSize < 100 || chunkSize > 10000) {
      return reply.status(400).send({ error: 'chunkSize must be between 100 and 10000' })
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
}
