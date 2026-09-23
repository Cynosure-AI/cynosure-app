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
import type { KnowledgeEntityType, ImportanceLevel } from '../core/memory/knowledge-types.js'
import { getDeepResearchConfig, saveDeepResearchConfig, type DeepResearchConfig } from '../core/memory/memory-deep-research.js'
import { dropConversationAttachmentIndex } from '../core/artifacts/attachment-rag.js'
import { getDb } from '../db/database.js'
import { getMemoryKnowledgeStore, MEMORY_KNOWLEDGE_PIPELINE_VERSION, MEMORY_KNOWLEDGE_VECTOR_TABLE } from '../core/memory/memory-knowledge.js'
import { activatePermanentMemoryIndex, DEFAULT_PERMANENT_MEMORY_TABLE, getActivePermanentMemoryTableName, setActivePermanentMemoryTableName } from '../core/memory/memory-index-manifest.js'
import { beginMemoryReembedding, finishMemoryReembedding } from '../core/memory/reembedding-operation.js'
import { getGateway } from '../core/gateway/gateway.js'
import { GRAPH_LIMITS, MEMORY_LIMITS } from '../core/runtime-limits.js'

type BroadcastFn = (event: string, data: unknown) => void

function markMemoryIndexesForRebuild(): void {
  // Preserve document_id/document_ref so the next source re-index replaces the
  // same governed knowledge revision instead of creating a parallel document.
  getDb().prepare(`
    UPDATE memory_file_index
    SET content_hash = '', chunk_count = 0, last_indexed_at = 0,
        deep_researched_at = 0, tags_json = '[]'
  `).run()
}

export async function registerMemoryRoutes(app: FastifyInstance, broadcast: BroadcastFn): Promise<void> {
  // GET /api/memory/limits — canonical cross-boundary limits.
  // The web client renders these instead of hardcoding its own copies so the
  // two sides cannot drift out of sync. See core/runtime-limits.ts.
  app.get('/limits', async () => MEMORY_LIMITS)

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
      graph: memory.graph,
      formatted: aggregator.format(memory)
    }
  })

  // GET /api/memory/knowledge/stats — inspect the authoritative derived knowledge plane.
  app.get('/knowledge/stats', async () => ({
    pipelineVersion: MEMORY_KNOWLEDGE_PIPELINE_VERSION,
    ...getMemoryKnowledgeStore().stats(),
  }))

  // POST /api/memory/knowledge/search — evidence-oriented diagnostics. This
  // returns exact source chunks as well as the selected assertion projection.
  app.post<{ Body: { query: string; folderIds: string[]; limit?: number } }>('/knowledge/search', async (req, reply) => {
    const query = req.body.query?.trim()
    const folderIds = Array.from(new Set((req.body.folderIds || []).filter((id): id is string => typeof id === 'string' && id.trim().length > 0)))
    if (!query) return reply.status(400).send({ error: 'A non-empty query is required' })
    if (!folderIds.length) return reply.status(400).send({ error: 'At least one memory folder is required' })
    const known = getDb().prepare(`SELECT id FROM memory_folders WHERE id IN (${folderIds.map(() => '?').join(', ')})`).all(...folderIds) as Array<{ id: string }>
    if (known.length !== folderIds.length) return reply.status(404).send({ error: 'Memory folder not found' })
    return getMemoryKnowledgeStore().search(query, folderIds, Math.min(50, Math.max(1, req.body.limit || 8)))
  })

  // GET /api/memory/knowledge/chunks/:id — lazily hydrate an exact source chunk for graph provenance.
  app.get<{ Params: { id: string } }>('/knowledge/chunks/:id', async (req, reply) => {
    const chunk = getMemoryKnowledgeStore().getSourceChunk(req.params.id)
    if (!chunk) return reply.status(404).send({ error: 'Knowledge source chunk not found' })
    return chunk
  })

  // GET /api/memory/knowledge/graph — inspect the authoritative knowledge graph projection.
  app.get<{ Querystring: { query?: string; nodeId?: string; nodeIds?: string; limit?: string; view?: string; minImportance?: string; folderIds?: string } }>('/knowledge/graph', async (req, reply) => {
    const knowledge = getMemoryKnowledgeStore()
    const limit = Math.min(Math.max(Number(req.query.limit) || GRAPH_LIMITS.defaultNodes, 1), GRAPH_LIMITS.maxNodes)
    const minImportance = Math.min(Math.max(Number(req.query.minImportance) || 0, 0), 3) as ImportanceLevel
    const nodeIds = (req.query.nodeIds || '').split(',').map((id) => id.trim()).filter(Boolean).slice(0, GRAPH_LIMITS.maxSeedNodes)
    const explicitlyEmpty = req.query.folderIds === '__none__'
    const folderIds = explicitlyEmpty
      ? []
      : Array.from(new Set((req.query.folderIds || '').split(',').map((id) => id.trim()).filter(Boolean))).slice(0, GRAPH_LIMITS.maxFolders)
    if (folderIds.length) {
      const known = getDb().prepare(`SELECT id FROM memory_folders WHERE id IN (${folderIds.map(() => '?').join(', ')})`).all(...folderIds) as Array<{ id: string }>
      if (known.length !== folderIds.length) return reply.status(404).send({ error: 'Memory folder not found' })
    }
    if (explicitlyEmpty) {
      return {
        stats: { nodeCount: 0, edgeCount: 0, recentEdgeCount: 0 },
        seedNodes: [],
        nodes: [],
        edges: [],
      }
    }
    const overview = knowledge.browseGraph({
      query: req.query.query?.trim(),
      nodeId: req.query.nodeId?.trim(),
      nodeIds,
      folderIds,
      limit,
      minImportance,
      // The relationship table should list facts directly involving the selected
      // entities. The visual graph keeps an extra hop to provide useful context.
      depth: req.query.view === 'relationships' ? 1 : 2,
    })
    return {
      stats: knowledge.graphStats(folderIds),
      seedNodes: overview.seedNodes,
      nodes: overview.nodes,
      edges: overview.edges
    }
  })

  // GET /api/memory/knowledge/graph/suggestions — autocomplete entity names
  app.get<{ Querystring: { query?: string; limit?: string; folderIds?: string } }>('/knowledge/graph/suggestions', async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || GRAPH_LIMITS.defaultSuggestions, 1), GRAPH_LIMITS.maxSuggestions)
    if (req.query.folderIds === '__none__') return { suggestions: [] }
    const folderIds = Array.from(new Set((req.query.folderIds || '').split(',').map((id) => id.trim()).filter(Boolean))).slice(0, GRAPH_LIMITS.maxFolders)
    return {
      suggestions: getMemoryKnowledgeStore().suggestNodes(req.query.query?.trim() || '', limit, folderIds)
    }
  })

  // PATCH /api/memory/knowledge/graph/nodes/:id — manually correct an entity node
  app.patch<{
    Params: { id: string }
    Body: { name?: string; type?: string; aliases?: string[]; importance?: number }
  }>('/knowledge/graph/nodes/:id', async (req, reply) => {
    const name = req.body.name?.trim()
    if (name !== undefined && name.length === 0) {
      return reply.status(400).send({ error: 'Entity name cannot be empty' })
    }
    const allowedKnowledgeEntityTypes: KnowledgeEntityType[] = ['person', 'place', 'organization', 'project', 'event', 'date', 'technology', 'product', 'artifact', 'concept', 'other']
    if (req.body.type !== undefined && !allowedKnowledgeEntityTypes.includes(req.body.type as KnowledgeEntityType)) {
      return reply.status(400).send({ error: 'Entity type is not valid' })
    }

    try {
      const knowledge = getMemoryKnowledgeStore()
      const existing = knowledge.getNode(req.params.id)
      if (!existing) return reply.status(404).send({ error: 'Entity not found' })
      const updated = knowledge.updateEntity(req.params.id, {
        name,
        type: req.body.type as KnowledgeEntityType | undefined,
        aliases: Array.isArray(req.body.aliases) ? req.body.aliases : undefined,
        importance: typeof req.body.importance === 'number' ? req.body.importance as 0 | 1 | 2 | 3 : undefined,
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

  // DELETE /api/memory/knowledge/graph/nodes/:id — manually remove an entity and its relationships
  app.delete<{ Params: { id: string } }>('/knowledge/graph/nodes/:id', async (req, reply) => {
    const knowledge = getMemoryKnowledgeStore()
    // Literal assertion values are projected as selectable graph nodes even
    // though they do not have a row in memory_knowledge_entities. Deleting one
    // means retracting the fact/edge that owns the synthetic node.
    if (req.params.id.startsWith('literal:')) {
      const assertionId = req.params.id.slice('literal:'.length)
      const result = knowledge.deleteEdge(assertionId)
      if (!result.edgeDeleted) return reply.status(404).send({ error: 'Fact not found' })
      return { success: true }
    }
    const deleted = knowledge.retractEntityById(req.params.id)
    if (!deleted) return reply.status(404).send({ error: 'Entity not found' })
    return { success: true }
  })

  // POST /api/memory/knowledge/graph/nodes/delete — atomically retract multiple entities.
  app.post<{ Body: { ids?: string[] } }>('/knowledge/graph/nodes/delete', async (req, reply) => {
    const ids = Array.from(new Set((req.body.ids || []).filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))))
    if (!ids.length) return reply.status(400).send({ error: 'At least one entity ID is required' })
    if (ids.length > 500) return reply.status(400).send({ error: 'At most 500 entities can be deleted at once' })
    const knowledge = getMemoryKnowledgeStore()
    const literalAssertionIds = ids.filter((id) => id.startsWith('literal:')).map((id) => id.slice('literal:'.length))
    const entityIds = ids.filter((id) => !id.startsWith('literal:'))
    if (entityIds.some((id) => !knowledge.getNode(id)) || literalAssertionIds.some((id) => !knowledge.getEdge(id))) {
      return reply.status(404).send({ error: 'One or more entities or facts no longer exist; nothing was deleted' })
    }
    const deletedEntities = entityIds.length ? knowledge.retractEntitiesByIds(entityIds) : 0
    const deletedFacts = literalAssertionIds.length ? knowledge.deleteEdgesByIds(literalAssertionIds) : 0
    const deleted = deletedEntities + deletedFacts
    if (deleted !== ids.length) return reply.status(404).send({ error: 'One or more entities or facts no longer exist' })
    return { success: true, deleted }
  })

  // PATCH /api/memory/knowledge/graph/edges/:id — manually correct a relationship
  app.patch<{
    Params: { id: string }
    Body: { relation?: string; note?: string; importance?: number }
  }>('/knowledge/graph/edges/:id', async (req, reply) => {
    const relation = req.body.relation?.trim()
    if (relation !== undefined && relation.length === 0) {
      return reply.status(400).send({ error: 'Relation cannot be empty' })
    }
    const updated = getMemoryKnowledgeStore().updateEdge(req.params.id, {
      relation,
      note: req.body.note,
      importance: typeof req.body.importance === 'number' ? req.body.importance as 0 | 1 | 2 | 3 : undefined,
    })
    if (!updated) return reply.status(404).send({ error: 'Relationship not found' })
    return updated
  })

  // DELETE /api/memory/knowledge/graph/edges/:id — manually remove a relationship
  app.delete<{ Params: { id: string } }>('/knowledge/graph/edges/:id', async (req, reply) => {
    const result = getMemoryKnowledgeStore().deleteEdge(req.params.id)
    if (!result.edgeDeleted) return reply.status(404).send({ error: 'Relationship not found' })
    return { success: true, orphanedNodeIds: result.orphanedNodeIds }
  })

  // POST /api/memory/knowledge/graph/edges/delete — atomically retract multiple relationships.
  app.post<{ Body: { ids?: string[] } }>('/knowledge/graph/edges/delete', async (req, reply) => {
    const ids = Array.from(new Set((req.body.ids || []).filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))))
    if (!ids.length) return reply.status(400).send({ error: 'At least one relationship ID is required' })
    if (ids.length > 1000) return reply.status(400).send({ error: 'At most 1,000 relationships can be deleted at once' })
    const deleted = getMemoryKnowledgeStore().deleteEdgesByIds(ids)
    if (deleted !== ids.length) return reply.status(404).send({ error: 'One or more relationships no longer exist; nothing was deleted' })
    return { success: true, deleted }
  })

  // DELETE /api/memory/knowledge/graph — clear the governed knowledge graph.
  app.delete('/knowledge/graph', async () => {
    const deleted = await getMemoryKnowledgeStore().reset()
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
        let knowledgeProjection: { runs: number; documents: number } | undefined
        let knowledgeProjectionError: string | undefined
        try {
          await rag.deleteTable(MEMORY_KNOWLEDGE_VECTOR_TABLE)
          getMemoryKnowledgeStore().markSearchProjectionsPending()
          knowledgeProjection = await getMemoryKnowledgeStore().reindexAllActiveSearchProjections(signal)
        } catch (error) {
          if (signal.aborted || (error as Error).name === 'AbortError') throw error
          knowledgeProjectionError = error instanceof Error ? error.message : String(error)
        }
        signal.throwIfAborted()
        broadcast('memory:reembed-progress', { current: totalReembedded, total: totalChunks, status: 'completed' })
        return { success: true, vectorsDropped: false, reembedded: true, reembeddedCount: totalReembedded, dimensions: newDimensions, knowledgeProjection, knowledgeProjectionError }
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
      await rag.deleteTable(MEMORY_KNOWLEDGE_VECTOR_TABLE)
      getMemoryKnowledgeStore().markSearchProjectionsPending()
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
    await rag.deleteTable(MEMORY_KNOWLEDGE_VECTOR_TABLE)
    getMemoryKnowledgeStore().markSearchProjectionsPending()
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

  // GET /api/memory/deep-research/config — get the extraction model target.
  app.get('/deep-research/config', async () => {
    return getDeepResearchConfig()
  })

  // POST /api/memory/deep-research/configure — set the extraction model target.
  app.post<{ Body: DeepResearchConfig }>('/deep-research/configure', async (req, reply) => {
    const providerId = req.body.providerId?.trim()
    if (providerId && !getGateway().getProvider(providerId)) {
      return reply.status(400).send({ error: 'Deep Research provider not found' })
    }
    const config = saveDeepResearchConfig({
      providerId,
      model: req.body.model,
    })
    return { success: true, ...config }
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

    const config = getMemoryReranker().saveConfig(req.body)
    return { success: true, ...config }
  })
}
