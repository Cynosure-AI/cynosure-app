import * as lancedb from '@lancedb/lancedb'
import { join } from 'path'
import { getAppDataDir } from '../data-dir.js'
import { lanceDbEqFilter, lanceDbInFilter } from './lancedb-filter.js'

type RRFReranker = lancedb.rerankers.RRFReranker

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VectorDocument {
  id: string
  text: string
  vector: number[]
  source: string
  sourceFile?: string
  chunkIndex?: number
  spaceId?: string
  createdAt: number
  searchText?: string
  documentTitle?: string
  sectionPath?: string
  contentHash?: string
  embeddingModel?: string
}

export interface SearchResult {
  id: string
  text: string
  source: string
  sourceFile?: string
  chunkIndex?: number
  spaceId?: string
  score: number
  /** Cosine similarity from dense retrieval, when available. */
  denseScore?: number
  /** Reciprocal-rank-fusion relevance returned by LanceDB hybrid search. */
  fusionScore?: number
  scoreType: 'dense' | 'fusion' | 'reranker'
  rerankerScore?: number
  createdAt: number
  documentTitle?: string
  sectionPath?: string
  contentHash?: string
}

export interface RAGOptimizeResult {
  tableName: string
  success: boolean
  compaction?: {
    fragmentsRemoved: number
    fragmentsAdded: number
    filesRemoved: number
    filesAdded: number
  }
  prune?: {
    bytesRemoved: number
    oldVersionsRemoved: number
  }
  error?: string
}

// ---------------------------------------------------------------------------
// RAGStore
// ---------------------------------------------------------------------------

export class RAGStore {
  private db: lancedb.Connection | null = null
  private tables = new Map<string, lancedb.Table>()
  private tableCreationPromises = new Map<string, Promise<lancedb.Table>>()

  // Index bookkeeping
  private spaceIdIndexReady = new Set<string>()
  // Tables whose FTS index covers all current data
  private ftsIndexCurrent = new Set<string>()
  // Debounce timers for FTS rebuilds after writes
  private ftsRebuildTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private optimizePromises = new Map<string, Promise<RAGOptimizeResult>>()
  // Cached RRF reranker instance (async creation, reused across searches)
  private rerankerPromise: Promise<RRFReranker> | null = null
  // Per-table schema field names — avoids a schema() round-trip on every addDocuments
  private fieldNamesCache = new Map<string, Set<string>>()

  async initialize(dbPath?: string, opts: { optimizeOnStartup?: boolean } = {}): Promise<void> {
    const path = dbPath || join(getAppDataDir(), 'lancedb')
    this.db = await lancedb.connect(path)
    if (opts.optimizeOnStartup) {
      const results = await this.optimizeTables()
      const reclaimed = results.reduce((total, result) => total + (result.prune?.bytesRemoved || 0), 0)
      const versions = results.reduce((total, result) => total + (result.prune?.oldVersionsRemoved || 0), 0)
      if (results.length) {
        console.log(`[rag] LanceDB startup optimize complete: ${versions} old version(s), ${reclaimed} byte(s) reclaimed`)
      }
    }
  }

  /** Get or create the shared RRF reranker (K=60). */
  private getReranker(): Promise<RRFReranker> {
    if (!this.rerankerPromise) {
      this.rerankerPromise = lancedb.rerankers.RRFReranker.create(60)
    }
    return this.rerankerPromise!
  }

  // -----------------------------------------------------------------------
  // Table lifecycle
  // -----------------------------------------------------------------------

  /** Open an existing table or return null. */
  private async openExistingTable(tableName: string): Promise<lancedb.Table | null> {
    if (this.tables.has(tableName)) return this.tables.get(tableName)!
    if (!this.db) return null
    try {
      const table = await this.db.openTable(tableName)
      this.tables.set(tableName, table)
      let schema = await table.schema()
      const existingFields = new Set(schema.fields.map((f: { name: string }) => f.name))
      const metadataColumns = [
        { name: 'searchText', valueSql: 'text' },
        { name: 'documentTitle', valueSql: "''" },
        { name: 'sectionPath', valueSql: "''" },
        { name: 'contentHash', valueSql: "''" },
        { name: 'embeddingModel', valueSql: "''" },
      ].filter((column) => !existingFields.has(column.name))
      if (metadataColumns.length > 0) {
        await table.addColumns(metadataColumns)
        schema = await table.schema()
      }
      this.fieldNamesCache.set(tableName, new Set(schema.fields.map((f: { name: string }) => f.name)))
      return table
    } catch {
      return null
    }
  }

  private async getOrCreateTable(
    tableName: string,
    dimensions: number
  ): Promise<lancedb.Table> {
    const existing = await this.openExistingTable(tableName)
    if (existing) return existing

    // Coalesce concurrent creation attempts
    const inflight = this.tableCreationPromises.get(tableName)
    if (inflight) return inflight

    if (!this.db) throw new Error('RAG store not initialized')

    const promise = (async () => {
      // Re-check after await — another call may have created it
      const existingNow = await this.openExistingTable(tableName)
      if (existingNow) return existingNow

      const seed: VectorDocument = {
        id: '__seed__',
        text: '',
        vector: new Array(dimensions).fill(0),
        source: 'system',
        sourceFile: '',
        chunkIndex: 0,
        spaceId: '',
        createdAt: Date.now(),
        searchText: '',
        documentTitle: '',
        sectionPath: '',
        contentHash: '',
        embeddingModel: ''
      }
      const table = await this.db!.createTable(tableName, [{ ...seed }])

      // Build initial FTS index — may fail on seed-only data; that's OK,
      // refreshFtsIndex will rebuild before the first real search.
      try {
        await table.createIndex('searchText', { config: lancedb.Index.fts() })
        this.ftsIndexCurrent.add(tableName)
      } catch { /* will retry before first search */ }

      this.tables.set(tableName, table)
      // Derive field names from seed — no extra round-trip needed for new tables
      this.fieldNamesCache.set(tableName, new Set(Object.keys(seed)))
      return table
    })().finally(() => {
      this.tableCreationPromises.delete(tableName)
    })

    this.tableCreationPromises.set(tableName, promise)
    return promise
  }

  // -----------------------------------------------------------------------
  // Index management
  // -----------------------------------------------------------------------

  /** Ensure a BTree scalar index on spaceId (once per table per process). */
  private async ensureSpaceIdIndex(table: lancedb.Table, tableName: string): Promise<void> {
    if (this.spaceIdIndexReady.has(tableName)) return
    try {
      const indices = await table.listIndices()
      if (!indices.some((idx) => idx.columns?.includes('spaceId'))) {
        await table.createIndex('spaceId', { config: lancedb.Index.btree() })
      }
      this.spaceIdIndexReady.add(tableName)
    } catch { /* will retry next time */ }
  }

  /**
   * Rebuild the FTS index so it covers all current data.
   * `replace: true` (the default) replaces any existing index.
   *
   * Called eagerly after bulk writes (uploads, deletes) so that search
   * never pays the rebuild cost. Also called lazily in hybridSearch as
   * a safety fallback if the index is still stale.
   */
  async rebuildFtsIndex(tableName: string): Promise<void> {
    const table = await this.openExistingTable(tableName)
    if (!table) return
    try {
      await table.createIndex('searchText', {
        config: lancedb.Index.fts(),
        replace: true
      })
      this.ftsIndexCurrent.add(tableName)
      console.log(`[rag] FTS index rebuilt for table "${tableName}"`)
    } catch {
      // FTS not available — hybrid search will fall back to vector-only
    }
  }

  /**
   * Schedule a debounced FTS index rebuild.
   * Each call resets the timer — the rebuild fires once after writes stop.
   * This handles bulk uploads (many files, each a separate HTTP request)
   * without rebuilding per-file.
   *
   * Timer is generous (15s) to avoid firing mid-upload where createIndex
   * can briefly lock the table. hybridSearch has a safety fallback that
   * rebuilds on-demand if a search happens before the timer fires.
   */
  private scheduleFtsRebuild(tableName: string): void {
    const existing = this.ftsRebuildTimers.get(tableName)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      this.ftsRebuildTimers.delete(tableName)
      this.rebuildFtsIndex(tableName).catch(() => { })
    }, 15_000)

    this.ftsRebuildTimers.set(tableName, timer)
  }

  async optimizeTable(tableName: string, cleanupOlderThan = new Date()): Promise<RAGOptimizeResult> {
    const inflight = this.optimizePromises.get(tableName)
    if (inflight) return inflight

    const promise = (async (): Promise<RAGOptimizeResult> => {
      const table = await this.openExistingTable(tableName)
      if (!table) {
        return { tableName, success: false, error: 'Table not found' }
      }

      try {
        const stats = await table.optimize({ cleanupOlderThan })
        return {
          tableName,
          success: true,
          compaction: stats.compaction,
          prune: stats.prune
        }
      } catch (err) {
        return {
          tableName,
          success: false,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    })().finally(() => {
      this.optimizePromises.delete(tableName)
    })

    this.optimizePromises.set(tableName, promise)
    return promise
  }

  async optimizeTables(tableNames?: string[], cleanupOlderThan = new Date()): Promise<RAGOptimizeResult[]> {
    if (!this.db) return []
    const names = tableNames ?? await this.db.tableNames()
    const unique = Array.from(new Set(names))
    return Promise.all(unique.map((tableName) => this.optimizeTable(tableName, cleanupOlderThan)))
  }

  // -----------------------------------------------------------------------
  // Write operations
  // -----------------------------------------------------------------------

  async ensureTable(tableName: string, dimensions: number): Promise<void> {
    await this.getOrCreateTable(tableName, dimensions)
  }

  async addDocuments(
    tableName: string,
    docs: VectorDocument[],
    dimensions: number
  ): Promise<void> {
    const table = await this.getOrCreateTable(tableName, dimensions)

    // Strip fields not in the table schema (handles old tables); use cached value when available
    const fieldNames =
      this.fieldNamesCache.get(tableName) ??
      new Set((await table.schema()).fields.map((f: { name: string }) => f.name))
    const prepared = docs.map((d) => {
      const clean: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(d)) {
        if (fieldNames.has(k)) clean[k] = v
      }
      return clean
    })

    await table.add(prepared)

    // New data invalidates the FTS index — schedule a debounced rebuild
    // (fires 15s after the last write, so bulk uploads only rebuild once)
    this.ftsIndexCurrent.delete(tableName)
    this.scheduleFtsRebuild(tableName)

    // Ensure scalar index on spaceId
    await this.ensureSpaceIdIndex(table, tableName)
  }

  // -----------------------------------------------------------------------
  // Search
  // -----------------------------------------------------------------------

  /** Pure vector search (cosine similarity). */
  async search(
    tableName: string,
    queryVector: number[],
    topK: number = 5,
    filter?: string
  ): Promise<SearchResult[]> {
    const table = await this.getOrCreateTable(tableName, queryVector.length)
    await this.ensureSpaceIdIndex(table, tableName)
    const fieldNames = await this.getFieldNames(table, tableName)
    const cols = ['id', 'text', 'source', 'sourceFile', 'chunkIndex', 'createdAt', '_distance', 'documentTitle', 'sectionPath', 'contentHash']
    if (fieldNames.has('spaceId')) cols.push('spaceId')

    let query = (table.search(queryVector) as lancedb.VectorQuery)
      .distanceType('cosine')
      .select(cols)
      .limit(topK)

    if (filter) query = query.where(filter)

    const results = await query.toArray()

    const mapped = results
      .filter((r) => r.id !== '__seed__')
      .map((r) => ({
        id: r.id as string,
        text: r.text as string,
        source: r.source as string,
        sourceFile: r.sourceFile as string | undefined,
        chunkIndex: r.chunkIndex != null ? (r.chunkIndex as number) : undefined,
        spaceId: (r.spaceId as string | undefined) || undefined,
        score: r._distance != null ? 1 - (r._distance as number) : 0,
        denseScore: r._distance != null ? 1 - (r._distance as number) : undefined,
        scoreType: 'dense' as const,
        documentTitle: (r.documentTitle as string | undefined) || undefined,
        sectionPath: (r.sectionPath as string | undefined) || undefined,
        contentHash: (r.contentHash as string | undefined) || undefined,
        createdAt: r.createdAt as number
      }))

    return mapped
  }

  /**
   * Hybrid search: vector similarity + full-text (BM25) merged via native RRF.
   *
   * Uses LanceDB's built-in RRF reranker to combine vector (cosine) and
   * FTS (BM25) results in a single optimized query.
   */
  async hybridSearch(
    tableName: string,
    queryVector: number[],
    queryText: string,
    topK: number = 5,
    filter?: string
  ): Promise<SearchResult[]> {
    const table = await this.getOrCreateTable(tableName, queryVector.length)
    const fieldNames = await this.getFieldNames(table, tableName)
    const cols = ['id', 'text', 'source', 'sourceFile', 'chunkIndex', 'createdAt', 'documentTitle', 'sectionPath', 'contentHash']
    if (fieldNames.has('spaceId')) cols.push('spaceId')

    // Safety fallback: rebuild FTS if callers didn't trigger it eagerly
    if (!this.ftsIndexCurrent.has(tableName)) {
      await this.rebuildFtsIndex(tableName)
    }
    await this.ensureSpaceIdIndex(table, tableName)

    // Native hybrid: vector + FTS + RRF in a single chained query
    try {
      const reranker = await this.getReranker()

      let hybridQuery = (table.search(queryVector) as lancedb.VectorQuery)
        .fullTextSearch(queryText, { columns: 'searchText' })
        .rerank(reranker)
        .select(cols)
        .limit(topK)
      if (filter) hybridQuery = hybridQuery.where(filter)

      const results = await hybridQuery.toArray()

      return results
        .filter((r) => r.id !== '__seed__')
        .map((r) => {
          const fusionScore = typeof r._relevance_score === 'number'
            ? r._relevance_score
            : undefined
          const denseScore = typeof r._distance === 'number' ? 1 - r._distance : undefined
          return {
            id: r.id as string,
            text: r.text as string,
            source: r.source as string,
            sourceFile: r.sourceFile as string | undefined,
            chunkIndex: r.chunkIndex != null ? (r.chunkIndex as number) : undefined,
            spaceId: (r.spaceId as string | undefined) || undefined,
            // A hybrid result must retain the score that produced its rank.
            // Dense and BM25 scores are not comparable, so never substitute a
            // secondary vector-only similarity for LanceDB's RRF score.
            score: fusionScore ?? 0,
            fusionScore,
            denseScore,
            scoreType: 'fusion' as const,
            documentTitle: (r.documentTitle as string | undefined) || undefined,
            sectionPath: (r.sectionPath as string | undefined) || undefined,
            contentHash: (r.contentHash as string | undefined) || undefined,
            createdAt: r.createdAt as number
          }
        })
    } catch (err) {
      // FTS not available or hybrid failed — fall back to vector-only
      console.warn('[rag] Hybrid search failed, vector-only fallback:', err)
      return this.search(tableName, queryVector, topK, filter)
    }
  }

  // -----------------------------------------------------------------------
  // Delete / utility operations
  // -----------------------------------------------------------------------

  async deleteByFilter(tableName: string, filter: string, opts: { rebuildFts?: boolean } = {}): Promise<void> {
    if (!this.db || !filter) return
    try {
      const table = await this.openExistingTable(tableName)
      if (!table) return
      await table.delete(filter)
      this.ftsIndexCurrent.delete(tableName)
      if (opts.rebuildFts !== false) {
        await this.rebuildFtsIndex(tableName)
      }
    } catch { /* best-effort */ }
  }

  /** Retrieve chunks from a specific source file within an index range. */
  async getChunksByRange(
    tableName: string,
    sourceFile: string,
    minIndex: number,
    maxIndex: number,
    filter?: string
  ): Promise<{ text: string; chunkIndex: number; sourceFile: string; spaceId?: string }[]> {
    if (!this.db) return []
    try {
      const table = await this.openExistingTable(tableName)
      if (!table) return []
      const fieldNames = await this.getFieldNames(table, tableName)
      const cols = ['id', 'text', 'chunkIndex', 'sourceFile']
      if (fieldNames.has('spaceId')) cols.push('spaceId')

      let whereClause = `${lanceDbEqFilter('sourceFile', sourceFile)} AND chunkIndex >= ${minIndex} AND chunkIndex <= ${maxIndex}`
      if (filter) whereClause += ` AND ${filter}`

      const results = await table.query().select(cols).where(whereClause).toArray()
      return results
        .filter((r) => r.id !== '__seed__')
        .map((r) => ({
          text: r.text as string,
          chunkIndex: r.chunkIndex as number,
          sourceFile: r.sourceFile as string,
          spaceId: (r.spaceId as string | undefined) || undefined
        }))
        .sort((a, b) => a.chunkIndex - b.chunkIndex)
    } catch {
      return []
    }
  }

  /** Count total chunks for a given source file. */
  async countBySource(
    tableName: string,
    sourceFile: string,
    filter?: string
  ): Promise<number> {
    if (!this.db) return 0
    try {
      const table = await this.openExistingTable(tableName)
      if (!table) return 0

      let whereClause = `${lanceDbEqFilter('sourceFile', sourceFile)} AND id != '__seed__'`
      if (filter) whereClause += ` AND ${filter}`

      return await table.countRows(whereClause)
    } catch {
      return 0
    }
  }

  async deleteTable(tableName: string): Promise<void> {
    if (!this.db) return
    try {
      await this.db.dropTable(tableName)
      this.clearTableCaches(tableName)
    } catch { /* table may not exist */ }
  }

  private clearTableCaches(tableName: string): void {
    const timer = this.ftsRebuildTimers.get(tableName)
    if (timer) clearTimeout(timer)
    this.ftsRebuildTimers.delete(tableName)
    this.tables.delete(tableName)
    this.fieldNamesCache.delete(tableName)
    this.ftsIndexCurrent.delete(tableName)
    this.spaceIdIndexReady.delete(tableName)
  }

  /** List all documents (excluding vectors) with optional filter. */
  async listDocuments(
    tableName: string,
    filter?: string,
    opts: { throwOnError?: boolean } = {},
  ): Promise<Omit<VectorDocument, 'vector'>[]> {
    if (!this.db) return []
    try {
      const table = await this.openExistingTable(tableName)
      if (!table) return []

      const fullCols = ['id', 'text', 'searchText', 'source', 'sourceFile', 'chunkIndex', 'spaceId', 'createdAt', 'documentTitle', 'sectionPath', 'contentHash', 'embeddingModel']
      const safeCols = ['id', 'text', 'source', 'createdAt']

      let results: Record<string, unknown>[]
      try {
        let q = table.query().select(fullCols)
        if (filter) q = q.where(filter)
        results = await q.toArray()
      } catch {
        let q = table.query().select(safeCols)
        if (filter) q = q.where(filter)
        results = await q.toArray()
      }

      return results
        .filter((r) => r.id !== '__seed__')
        .map((r) => ({
          id: r.id as string,
          text: r.text as string,
          source: r.source as string,
          sourceFile: (r.sourceFile as string | undefined) || undefined,
          chunkIndex: r.chunkIndex != null ? (r.chunkIndex as number) : undefined,
          spaceId: (r.spaceId as string | undefined) || undefined,
          createdAt: r.createdAt as number,
          searchText: (r.searchText as string | undefined) || undefined,
          documentTitle: (r.documentTitle as string | undefined) || undefined,
          sectionPath: (r.sectionPath as string | undefined) || undefined,
          contentHash: (r.contentHash as string | undefined) || undefined,
          embeddingModel: (r.embeddingModel as string | undefined) || undefined
        }))
    } catch (err) {
      console.error('[rag] listDocuments error:', (err as Error).message)
      if (opts.throwOnError) throw err
      return []
    }
  }

  /** List unique document groups (by sourceFile) with chunk counts. */
  async listDocumentGroups(
    tableName: string,
    filter?: string
  ): Promise<{ sourceFile: string; chunkCount: number; latestCreatedAt: number }[]> {
    if (!this.db) return []
    try {
      const table = await this.openExistingTable(tableName)
      if (!table) return []

      let q = table.query().select(['id', 'sourceFile', 'createdAt'])
      if (filter) q = q.where(filter)
      const results = await q.toArray()

      const groupMap = new Map<string, { count: number; latestCreatedAt: number }>()
      for (const r of results) {
        if (r.id === '__seed__') continue
        const key = (r.sourceFile as string) || ''
        const ts = (r.createdAt as number) || 0
        const existing = groupMap.get(key)
        if (existing) {
          existing.count++
          if (ts > existing.latestCreatedAt) existing.latestCreatedAt = ts
        } else {
          groupMap.set(key, { count: 1, latestCreatedAt: ts })
        }
      }

      return Array.from(groupMap.entries())
        .map(([sourceFile, { count, latestCreatedAt }]) => ({
          sourceFile,
          chunkCount: count,
          latestCreatedAt
        }))
        .sort((a, b) => {
          if (a.sourceFile && !b.sourceFile) return -1
          if (!a.sourceFile && b.sourceFile) return 1
          return a.sourceFile.localeCompare(b.sourceFile)
        })
    } catch (err) {
      console.error('[rag] listDocumentGroups error:', (err as Error).message)
      return []
    }
  }

  /** Delete all chunks for a given source file. */
  async deleteBySource(
    tableName: string,
    sourceFile: string,
    filter?: string,
    opts: { rebuildFts?: boolean; throwOnError?: boolean } = {},
  ): Promise<number> {
    return this.deleteBySources(tableName, [sourceFile], filter, opts)
  }

  /** Delete all chunks for multiple source files. */
  async deleteBySources(
    tableName: string,
    sourceFiles: string[],
    filter?: string,
    opts: { rebuildFts?: boolean; throwOnError?: boolean } = {},
  ): Promise<number> {
    if (!this.db || sourceFiles.length === 0) return 0
    try {
      const table = await this.openExistingTable(tableName)
      if (!table) return 0
      let whereClause = lanceDbInFilter('sourceFile', sourceFiles)
      if (!whereClause) return 0
      if (filter) whereClause += ` AND ${filter}`
      const deletedCount = await table.countRows(whereClause)
      await table.delete(whereClause)
      this.ftsIndexCurrent.delete(tableName)
      if (opts.rebuildFts !== false) {
        await this.rebuildFtsIndex(tableName)
      }
      return deletedCount
    } catch (err) {
      if (opts.throwOnError) throw err
      return 0
    }
  }

  private async getFieldNames(table: lancedb.Table, tableName: string): Promise<Set<string>> {
    const cached = this.fieldNamesCache.get(tableName)
    if (cached) return cached
    const names = new Set((await table.schema()).fields.map((f: { name: string }) => f.name))
    this.fieldNamesCache.set(tableName, names)
    return names
  }

  /** Delete documents by their IDs. */
  async deleteByIds(tableName: string, ids: string[], opts: { rebuildFts?: boolean; throwOnError?: boolean } = {}): Promise<void> {
    if (!this.db || ids.length === 0) return
    try {
      const table = await this.openExistingTable(tableName)
      if (!table) return
      const filter = lanceDbInFilter('id', ids)
      if (!filter) return
      await table.delete(filter)
      this.ftsIndexCurrent.delete(tableName)
      if (opts.rebuildFts !== false) {
        await this.rebuildFtsIndex(tableName)
      }
    } catch (err) {
      if (opts.throwOnError) throw err
    }
  }

  async close(): Promise<void> {
    // Cancel any pending FTS rebuild timers
    for (const timer of this.ftsRebuildTimers.values()) clearTimeout(timer)
    this.ftsRebuildTimers.clear()
    this.tables.clear()
    this.fieldNamesCache.clear()
    this.ftsIndexCurrent.clear()
    this.spaceIdIndexReady.clear()
    this.rerankerPromise = null
    this.db = null
  }

  /** Update the spaceId for documents matching a filter. */
  async updateSpaceId(tableName: string, filter: string, newSpaceId: string): Promise<void> {
    if (!this.db || !filter) return
    try {
      const table = await this.openExistingTable(tableName)
      if (!table) return
      await table.update({ where: filter, values: { spaceId: newSpaceId } })
    } catch (err) {
      console.error('[rag] updateSpaceId error:', (err as Error).message)
    }
  }

  /** Update the sourceFile for documents matching a filter. */
  async updateSourceFile(tableName: string, filter: string, newSourceFile: string): Promise<void> {
    if (!this.db || !filter) return
    try {
      const table = await this.openExistingTable(tableName)
      if (!table) return
      await table.update({ where: filter, values: { sourceFile: newSourceFile } })
    } catch (err) {
      console.error('[rag] updateSourceFile error:', (err as Error).message)
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let ragStoreInstance: RAGStore | null = null

export function getRAGStore(): RAGStore {
  if (!ragStoreInstance) {
    ragStoreInstance = new RAGStore()
  }
  return ragStoreInstance
}
