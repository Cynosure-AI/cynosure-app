import { nanoid } from 'nanoid'
import { createHash } from 'node:crypto'
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { getEmbeddingProvider } from './embedding.js'
import { getRAGStore, type VectorDocument } from './rag.js'
import type { SearchResult } from './rag.js'
import { getMemoryReranker } from './reranker.js'
import { getDb } from '../../db/database.js'

export interface DocumentMeta {
  source: string
  sourceFile?: string
  spaceId?: string
}

export interface RetrievedChunk {
  id: string
  text: string
  source: string
  score: number
  rerankerScore?: number
  denseScore?: number
  fusionScore?: number
  scoreType?: 'dense' | 'fusion' | 'reranker'
  sourceFile?: string
  chunkIndex?: number
  spaceId?: string
  spaceName?: string
  totalChunks?: number
  documentTitle?: string
  sectionPath?: string
  contentHash?: string
  documentId?: string
  revision?: string
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const err = new Error('Cancelled')
  err.name = 'AbortError'
  throw err
}

/** Average characters per token — used to convert token-based chunk settings to the
 * character counts that RecursiveCharacterTextSplitter expects. */
const CHARS_PER_TOKEN = 4

/**
 * Parser pipeline: chunk → embed → store in LanceDB.
 * Also handles retrieval: embed query → search → return ranked results.
 */
export class MemoryParser {
  private chunkSize: number
  private chunkOverlap: number

  constructor(opts?: { chunkSize?: number; chunkOverlap?: number }) {
    this.chunkSize = opts?.chunkSize ?? 512
    this.chunkOverlap = opts?.chunkOverlap ?? 64
  }

  /** Reload chunk config from DB settings. */
  refreshConfig(): void {
    try {
      const db = getDb()
      const row = db.prepare("SELECT value_json FROM settings WHERE key = 'chunking'").get() as { value_json: string } | undefined
      if (row) {
        const cfg = JSON.parse(row.value_json) as { chunkSize?: number; chunkOverlap?: number }
        if (cfg.chunkSize && cfg.chunkSize >= 64) this.chunkSize = cfg.chunkSize
        if (cfg.chunkOverlap !== undefined && cfg.chunkOverlap >= 0) this.chunkOverlap = cfg.chunkOverlap
      }
    } catch { /* DB not ready yet — use defaults */ }
  }

  getConfig(): { chunkSize: number; chunkOverlap: number } {
    return { chunkSize: this.chunkSize, chunkOverlap: this.chunkOverlap }
  }

  /**
   * Chunk text, embed each chunk, and store in LanceDB.
   * Processes in batches to avoid OOM on large files.
   *
   * Uses a sliding-window pipeline: each batch's embeddings are computed
   * concurrently with the previous batch's LanceDB write, so CPU and I/O
   * overlap instead of serialising. Vector dimensions are resolved once
   * from the first batch result and reused for all subsequent writes.
   *
   * Both embedding calls and write calls are retried up to 2 times with
   * exponential back-off on transient failures. If a batch ultimately
   * fails, every row written by this ingest attempt is rolled back and the
   * error is propagated. A partial index must never be reported as usable.
   */
  async ingest(
    tableName: string,
    text: string,
    meta: DocumentMeta,
    opts?: { signal?: AbortSignal }
  ): Promise<number> {
    throwIfAborted(opts?.signal)
    const chunks = await this.chunk(text)
    throwIfAborted(opts?.signal)
    if (chunks.length === 0) return 0

    const embedder = getEmbeddingProvider()
    const ragStore = getRAGStore()
    const BATCH_SIZE = 32
    let totalStored = 0
    let dimensions: number | undefined
    const documentTitle = inferDocumentTitle(text, meta.sourceFile)

    // pendingWrite tracks the in-flight LanceDB write and its chunk count so
    // we can overlap it with the next embedding batch (sliding-window pipeline)
    // and only increment totalStored once the write is confirmed.
    let pendingWrite: { promise: Promise<void>; ids: string[] } | null = null
    const storedIds: string[] = []

    try {
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        throwIfAborted(opts?.signal)
        const batch = chunks.slice(i, i + BATCH_SIZE)
        const enrichedBatch = batch.map((chunk) => {
          const sectionPath = inferSectionPath(chunk, documentTitle)
          const searchText = [
            documentTitle ? `Document: ${documentTitle}` : '',
            sectionPath && sectionPath !== documentTitle ? `Section: ${sectionPath}` : '',
            chunk,
          ].filter(Boolean).join('\n')
          return { chunk, sectionPath, searchText }
        })

        // Start embedding current batch immediately so it runs concurrently
        // with the previous batch's LanceDB write (sliding-window pipeline).
        const embedPromise = MemoryParser.withRetry(() => embedder.embedBatch(enrichedBatch.map((item) => item.searchText)))

        // Wait for the previous write to finish, then count it.
        const completedWrite = pendingWrite
        await (completedWrite?.promise ?? Promise.resolve())
        if (completedWrite) {
          totalStored += completedWrite.ids.length
          storedIds.push(...completedWrite.ids)
          pendingWrite = null
        }

        const embeddings = await embedPromise
        throwIfAborted(opts?.signal)

        // Resolve dimensions once; they never change for a given provider.
        if (dimensions === undefined) dimensions = embeddings[0].dimensions
        const dims = dimensions as number

        const docs: VectorDocument[] = enrichedBatch.map((item, j) => ({
          id: nanoid(),
          text: item.chunk,
          searchText: item.searchText,
          vector: embeddings[j].vector,
          source: meta.source,
          sourceFile: meta.sourceFile || '',
          chunkIndex: i + j,
          spaceId: meta.spaceId || '',
          createdAt: Date.now(),
          documentTitle,
          sectionPath: item.sectionPath,
          contentHash: createHash('sha256').update(item.chunk).digest('hex'),
          embeddingModel: embeddings[j].model
        }))

        pendingWrite = {
          promise: MemoryParser.withRetry(() => ragStore.addDocuments(tableName, docs, dims)),
          ids: docs.map((doc) => doc.id)
        }
      }

      // Flush the last in-flight write.
      if (pendingWrite) {
        await pendingWrite.promise
        throwIfAborted(opts?.signal)
        totalStored += pendingWrite.ids.length
        storedIds.push(...pendingWrite.ids)
      }
    } catch (err) {
      // Settle the in-flight write, then remove every row belonging to this
      // attempt. Cancellation follows the same rollback path as failure.
      if (pendingWrite) {
        try {
          await pendingWrite.promise
        } catch {
          // Still attempt cleanup in case a failed storage operation became
          // partially visible.
        } finally {
          storedIds.push(...pendingWrite.ids)
        }
      }
      if (storedIds.length > 0) {
        await ragStore.deleteByIds(tableName, Array.from(new Set(storedIds)), { throwOnError: true }).catch((rollbackError) => {
          console.error('[MemoryParser] failed to roll back incomplete ingest:', rollbackError)
        })
      }
      console.error(`[MemoryParser] ingest failed; rolled back ${storedIds.length} chunk(s):`, err)
      throw err
    }

    return totalStored
  }

  /** Retry helper: up to `retries` re-attempts with exponential back-off. */
  private static async withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn()
      } catch (err) {
        if (attempt === retries) throw err
        await new Promise(r => setTimeout(r, 300 * 2 ** attempt))
      }
    }
    throw new Error('unreachable')
  }

  /**
   * Embed a query and search the vector store using hybrid search (vector + FTS).
   */
  async retrieve(
    tableName: string,
    query: string,
    topK: number = 5,
    filter?: string
  ): Promise<RetrievedChunk[]> {
    const embedder = getEmbeddingProvider()
    const ragStore = getRAGStore()
    const reranker = getMemoryReranker()

    const { vector } = await embedder.embed(query)
    const candidateCount = reranker.getCandidateCount(topK)
    const results = (await ragStore.hybridSearch(tableName, vector, query, candidateCount, filter))
      .filter((result) => isRetrievableChunk(result.text))
    const ranked = await reranker.rerank(query, results, topK).catch((err) => {
      console.warn('[memory-reranker] Rerank failed, using hybrid ranking:', err)
      return results.slice(0, topK)
    })
    const minMatchThreshold = reranker.getMinMatchThreshold()
    const filtered = ranked.filter((r) => passesRetrievalThreshold(r, minMatchThreshold))

    return filtered.map((r) => ({
      id: r.id,
      text: r.text,
      source: r.source,
      score: r.score,
      rerankerScore: r.rerankerScore,
      denseScore: r.denseScore,
      fusionScore: r.fusionScore,
      scoreType: r.scoreType,
      documentTitle: r.documentTitle,
      sectionPath: r.sectionPath,
      contentHash: r.contentHash,
      sourceFile: r.sourceFile,
      chunkIndex: r.chunkIndex,
      spaceId: r.spaceId
    }))
  }

  /**
   * Split text into chunks using markdown-aware recursive splitting.
   * Uses @langchain/textsplitters to split at structural boundaries
   * (headings, code blocks, lists, paragraphs) before falling back
   * to sentence and character boundaries.
   *
   * After splitting, heading-only chunks (no body text) are merged forward
   * into the next content chunk so headings provide context rather than
   * becoming standalone noise.
   */
  private async chunk(text: string): Promise<string[]> {
    const trimmed = text.trim()
    if (!trimmed) return []
    if (trimmed.length <= this.chunkSize * CHARS_PER_TOKEN) {
      return isRetrievableChunk(trimmed) ? [trimmed] : []
    }

    const splitter = RecursiveCharacterTextSplitter.fromLanguage('markdown', {
      chunkSize: this.chunkSize * CHARS_PER_TOKEN,
      chunkOverlap: this.chunkOverlap * CHARS_PER_TOKEN,
    })

    const docs = await splitter.createDocuments([trimmed])
    const raw = docs.map(d => d.pageContent).filter(isRetrievableChunk)
    return this.mergeHeadingOnlyChunks(raw).filter(isRetrievableChunk)
  }

  /**
   * Merge heading-only chunks (lines that are all `#…`) forward into the next
   * content chunk. This prevents isolated header chunks with no retrievable
   * content while ensuring each content chunk carries its heading context.
   *
   * Trailing heading-only chunks (headings with no following content) are
   * silently dropped — they carry no retrievable information.
   */
  private mergeHeadingOnlyChunks(chunks: string[]): string[] {
    const result: string[] = []
    let pendingHeadings = ''

    for (const chunk of chunks) {
      const nonEmptyLines = chunk.split('\n').map(l => l.trim()).filter(Boolean)
      const isHeadingOnly = nonEmptyLines.length > 0 && nonEmptyLines.every(l => l.startsWith('#'))

      if (isHeadingOnly) {
        pendingHeadings = pendingHeadings ? `${pendingHeadings}\n${chunk}` : chunk
      } else {
        result.push(pendingHeadings ? `${pendingHeadings}\n\n${chunk}` : chunk)
        pendingHeadings = ''
      }
    }

    return result
  }
}

/** Reject markup fragments and other chunks that carry no searchable meaning. */
export function isRetrievableChunk(value: string): boolean {
  const text = value.trim()
  if (!text) return false
  const withoutMarkdown = text
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/[`*_~>\-|=+:.\s]/g, '')
  if (withoutMarkdown.length < 3) return false
  return /[\p{L}\p{N}]/u.test(withoutMarkdown)
}

export function passesRetrievalThreshold(result: SearchResult, rerankerThreshold: number): boolean {
  // Thresholds are calibrated for a particular reranker. Applying the same
  // value to cosine similarity or RRF scores is mathematically invalid.
  if (typeof result.rerankerScore !== 'number') return true
  return Number.isFinite(result.rerankerScore) && result.rerankerScore >= rerankerThreshold
}

export function inferDocumentTitle(text: string, sourceFile?: string): string {
  const heading = text.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim()
  if (heading) return heading.slice(0, 240)
  return (sourceFile || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 240)
}

export function inferSectionPath(chunk: string, documentTitle: string): string {
  const headings = Array.from(chunk.matchAll(/^\s*#{1,6}\s+(.+?)\s*$/gm))
    .map((match) => match[1].trim())
    .filter(Boolean)
  return (headings.at(-1) || documentTitle).slice(0, 500)
}

let parserInstance: MemoryParser | null = null

export function getMemoryParser(): MemoryParser {
  if (!parserInstance) {
    parserInstance = new MemoryParser()
    parserInstance.refreshConfig()
  }
  return parserInstance
}
