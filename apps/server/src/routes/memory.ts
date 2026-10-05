import { getDreamConfig, saveDreamConfig } from '../core/memory/dream-store.js'
import { cancelAllDreamRuns, cancelDreamRun, settleDreamWork, settleDreamRun } from '../core/memory/dream-worker.js'
import type { FastifyInstance } from 'fastify'
import { getAgentMemory } from '../core/memory/agent-memory.js'
import { getMemoryAggregator } from '../core/memory/memory-aggregator.js'
import { getHistoryStore } from '../core/memory/history.js'
import { EmbeddingService, getEmbeddingConfig, getEmbeddingService, getStoredEmbeddingConfig, probeEmbeddingDimensions, setEmbeddingService, type EmbeddingConfig } from '../core/memory/embedding.js'
import { getMemoryReranker, type MemoryRerankerConfig } from '../core/memory/reranker.js'
import { getRAGStore } from '../core/memory/rag.js'
import { buildMemoryFolderFilter, getAllMemoryFolders } from '../core/memory/memory-folder-scope.js'
import { dropConversationAttachmentIndex } from '../core/artifacts/attachment-rag.js'
import { getDb } from '../db/database.js'
import { activatePermanentMemoryIndex, DEFAULT_PERMANENT_MEMORY_TABLE, getActivePermanentMemoryTableName, setActivePermanentMemoryTableName } from '../core/memory/memory-index-manifest.js'
import { beginMemoryReembedding, finishMemoryReembedding } from '../core/memory/reembedding-operation.js'
import { getGateway } from '../core/gateway/gateway.js'
import { RUNTIME_LIMITS } from '../core/runtime-limits.js'

type BroadcastFn = (event: string, data: unknown) => void

function markMemoryIndexesForRebuild(): void {
  // Preserve document_id/document_ref so the next source re-index keeps the
  // document identity and its revision history.
  getDb().prepare(`
    UPDATE memory_file_index
    SET content_hash = '', chunk_count = 0, last_indexed_at = 0
  `).run()
}

export async function registerMemoryRoutes(app: FastifyInstance, broadcast: BroadcastFn): Promise<void> {
  // GET /api/memory/limits — canonical cross-boundary limits.
  // The web client renders these instead of hardcoding its own copies so the
  // two sides cannot drift out of sync. See core/runtime-limits.ts.
  app.get('/limits', async () => RUNTIME_LIMITS)

  // POST /api/memory/search — search permanent memory
  app.post<{ Body: { query: string; topK?: number; folderId?: string } }>('/search', async (req, reply) => {
    const { query, topK, folderId } = req.body
    if (typeof query !== 'string' || !query.trim()) {
      return reply.code(400).send({ error: 'A non-empty search query is required' })
    }
    const boundedTopK = Math.min(100, Math.max(1, Math.round(topK ?? 5)))
    const mem = getAgentMemory()
    let filter: string | undefined

    if (folderId?.trim()) {
      const db = getDb()
      const row = db
        .prepare('SELECT id, name FROM memory_folders WHERE id = ?')
        .get(folderId.trim()) as { id: string; name: string } | undefined
      if (!row) return reply.code(404).send({ error: 'Memory folder not found' })
      filter = buildMemoryFolderFilter([row])
    } else {
      filter = buildMemoryFolderFilter(getAllMemoryFolders())
    }

    return mem.recall(query.trim(), boundedTopK, filter)
  })

  // POST /api/memory/aggregate — aggregated search
  app.post<{
    Body: { query: string; opts?: { taskId?: string; conversationId?: string; agentId?: string; folderIds?: string[] } }
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
  }>('/embeddings/configure', async (req, reply) => {
    const oldConfig = getEmbeddingConfig()
    const { reembed, ...configOpts } = req.body
    const savedConfig = getStoredEmbeddingConfig()
    const providerChanged = configOpts.providerId !== undefined && configOpts.providerId !== savedConfig.providerId
    const directChanged = (configOpts.baseUrl !== undefined || configOpts.apiKey !== undefined) && configOpts.providerId === undefined
    const nextConfig = {
      ...savedConfig,
      ...(providerChanged ? { baseUrl: undefined, apiKey: undefined } : {}),
      ...(directChanged ? { providerId: undefined } : {}),
      ...configOpts,
    }
    const connectionChanged = providerChanged || configOpts.baseUrl !== undefined || configOpts.apiKey !== undefined
    let resolvedConfig: EmbeddingConfig
    let nextService: EmbeddingService
    try {
      const dimensions = configOpts.dimensions ||
        (!connectionChanged && nextConfig.model === oldConfig.model ? oldConfig.dimensions : undefined) ||
        await probeEmbeddingDimensions(nextConfig)
      resolvedConfig = { ...nextConfig, dimensions }
      nextService = new EmbeddingService(resolvedConfig)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
    const embeddingChanged = nextService.profile.fingerprint !== (() => {
      try { return getEmbeddingService().profile.fingerprint } catch { return '' }
    })()
    const newDimensions = nextService.profile.dimensions

    if (embeddingChanged && reembed) {
      const reembedding = beginMemoryReembedding()
      if (!reembedding) {
        return reply.code(409).send({ error: 'A memory re-embedding operation is already running' })
      }
      const { signal } = reembedding
      // Blue/green re-embedding: build and verify an isolated table, then swap.
      // The active provider and table remain available throughout staging.
      const rag = getRAGStore()
      const activeTable = getActivePermanentMemoryTableName()
      const migrationEmbedder = nextService
      const migrationId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const stagingTable = `permanent_memory_v_${migrationId}`
      let activated = false
      let totalChunks = 0

      try {
        const existingDocs = await rag.listDocuments(activeTable)
        const chunksToReembed = existingDocs.filter(d => d.id !== '__seed__')
        // Re-embed in batches
        const BATCH_SIZE = 32
        let totalReembedded = 0
        totalChunks = chunksToReembed.length
        await rag.ensureTable(stagingTable, newDimensions)
        signal.throwIfAborted()

        broadcast('memory:reembed-progress', { current: 0, total: totalChunks, status: 'started' })

        for (let i = 0; i < chunksToReembed.length; i += BATCH_SIZE) {
          const batch = chunksToReembed.slice(i, i + BATCH_SIZE)
          const texts = batch.map(d => d.searchText || d.text)

          try {
            signal.throwIfAborted()
            const embeddings = await migrationEmbedder.embedBatch(texts, signal)
            signal.throwIfAborted()
            if (embeddings.length !== batch.length || embeddings.some((item) => item.vector.length !== newDimensions)) {
              throw new Error(`Embedding batch ${i / BATCH_SIZE + 1} returned invalid dimensions or row count`)
            }
            const docs = batch.map((doc, j) => ({
              id: doc.id,
              text: doc.text,
              searchText: doc.searchText || doc.text,
              vector: embeddings[j].vector,
              source: doc.source,
              sourceFile: doc.sourceFile || '',
              chunkIndex: doc.chunkIndex ?? 0,
              folderId: doc.folderId || '',
              createdAt: doc.createdAt,
              documentTitle: doc.documentTitle || '',
              sectionPath: doc.sectionPath || '',
              contentHash: doc.contentHash || '',
              embeddingModel: embeddings[j].model,
              embeddingProfileFingerprint: embeddings[j].profileFingerprint,
              representationType: doc.representationType || 'raw',
              sourceChunkId: doc.sourceChunkId || doc.id,
            }))
            await rag.addDocuments(stagingTable, docs, newDimensions)
            signal.throwIfAborted()
            totalReembedded += docs.length
            broadcast('memory:reembed-progress', { current: totalReembedded, total: totalChunks, status: 'in-progress' })
          } catch (err) {
            throw new Error(`Re-embedding failed at chunk ${i}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }

        const stagedDocs = await rag.listDocuments(stagingTable)
        signal.throwIfAborted()
        if (stagedDocs.length !== totalChunks) {
          throw new Error(`Staging verification failed: expected ${totalChunks} chunks, found ${stagedDocs.length}`)
        }
        if (stagedDocs.some((doc) => doc.embeddingProfileFingerprint !== nextService.profile.fingerprint)) {
          throw new Error('Staging verification failed: embedding profile mismatch')
        }
        await rag.rebuildFtsIndex(stagingTable)
        signal.throwIfAborted()

        // Attachment vectors use the old dimensions, so invalidate them before
        // publishing the new provider/index pair.
        await dropConversationAttachmentIndex()
        signal.throwIfAborted()
        activatePermanentMemoryIndex(stagingTable, resolvedConfig, nextService.profile.fingerprint)
        setEmbeddingService(resolvedConfig, false)
        activated = true
        if (activeTable !== stagingTable) await rag.deleteTable(activeTable)
        signal.throwIfAborted()
        broadcast('memory:reembed-progress', { current: totalReembedded, total: totalChunks, status: 'completed' })
        return { success: true, vectorsDropped: false, reembedded: true, reembeddedCount: totalReembedded, dimensions: newDimensions }
      } catch (err) {
        if (!activated) await rag.deleteTable(stagingTable).catch(() => undefined)
        const cancelled = signal.aborted || (err as Error).name === 'AbortError'
        broadcast('memory:reembed-progress', {
          current: 0,
          total: totalChunks,
          status: cancelled ? 'cancelled' : 'failed',
          error: cancelled ? 'Cancelled by user' : err instanceof Error ? err.message : String(err),
        })
        if (cancelled) return reply.code(409).send({ error: 'Memory re-embedding was cancelled' })
        throw err
      } finally {
        finishMemoryReembedding(reembedding)
      }
    }

    if (embeddingChanged) {
      const rag = getRAGStore()
      const activeTable = getActivePermanentMemoryTableName()
      await rag.deleteTable(activeTable)
      if (activeTable !== DEFAULT_PERMANENT_MEMORY_TABLE) {
        await rag.deleteTable(DEFAULT_PERMANENT_MEMORY_TABLE)
      }
      await dropConversationAttachmentIndex()
      markMemoryIndexesForRebuild()
      activatePermanentMemoryIndex(DEFAULT_PERMANENT_MEMORY_TABLE, resolvedConfig, nextService.profile.fingerprint)
      setEmbeddingService(resolvedConfig, false)
    } else {
      setEmbeddingService(resolvedConfig)
    }

    return { success: true, vectorsDropped: embeddingChanged, reembedded: false, reembeddedCount: 0, dimensions: newDimensions }
  })

  // GET /api/memory/embeddings/config — get current embedding config
  app.get('/embeddings/config', async () => {
    return getEmbeddingConfig()
  })

  // POST /api/memory/embeddings/drop — drop all vector data
  app.post('/embeddings/drop', async () => {
    const rag = getRAGStore()
    const activeTable = getActivePermanentMemoryTableName()
    await rag.deleteTable(activeTable)
    setActivePermanentMemoryTableName(DEFAULT_PERMANENT_MEMORY_TABLE)
    await dropConversationAttachmentIndex()
    markMemoryIndexesForRebuild()
    return { success: true }
  })

  app.get('/dream/config', async () => getDreamConfig())
  app.post<{ Body: { enabled: boolean; providerId: string; model: string } }>('/dream/configure', async (req, reply) => {
    const body = req.body
    if (!body || typeof body.enabled !== 'boolean' || typeof body.providerId !== 'string' || typeof body.model !== 'string') {
      return reply.status(400).send({ error: 'Dream requires enabled, providerId, and model settings' })
    }
    const providerId = body.providerId.trim()
    const model = body.model.trim()
    const provider = providerId ? getGateway().getProvider(providerId) : undefined
    const resolvedModel = model || provider?.config.defaultModel?.trim()
    if (body.enabled && (!provider || !resolvedModel)) {
      return reply.status(400).send({ error: 'Select an available provider and model before enabling Dream Mode' })
    }
    if (!body.enabled) cancelAllDreamRuns()
    const config = saveDreamConfig({ enabled: body.enabled, providerId, model })
    if (!body.enabled) await settleDreamWork()
    return config
  })
  app.post<{ Params: { id: string } }>('/dream/runs/:id/cancel', async (req, reply) => {
    if (!cancelDreamRun(req.params.id)) return reply.status(409).send({ error: 'Dream review is no longer cancellable' })
    await settleDreamRun(req.params.id)
    return { success: true }
  })

  // POST /api/memory/embeddings/probe — test-embed a token to detect output dimensions
  app.post<{
    Body: { providerId?: string; model: string }
  }>('/embeddings/probe', async (req, reply) => {
    const { providerId, model } = req.body
    try {
      return { dimensions: await probeEmbeddingDimensions({ providerId, model }) }
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message })
    }
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
    if (req.body.curationProviderId && !getGateway().getProvider(req.body.curationProviderId)) {
      return reply.status(400).send({ error: 'Curation provider not found' })
    }

    const config = getMemoryReranker().saveConfig(req.body)
    return { success: true, ...config }
  })
}
