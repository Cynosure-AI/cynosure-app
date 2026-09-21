import { nanoid } from 'nanoid'
import { createHash } from 'node:crypto'
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { getEmbeddingProvider } from './embedding.js'
import { getRAGStore, type VectorDocument } from './rag.js'
import type { SearchResult } from './rag.js'
import { getMemoryReranker } from './reranker.js'
import { MEMORY_CHUNK_OVERLAP_TOKENS, MEMORY_CHUNK_SIZE_TOKENS } from '../runtime-limits.js'

export interface DocumentMeta {
  source: string
  sourceFile?: string
  folderId?: string
}

export interface RetrievedChunk {
  id: string
  text: string
  source: string
  score: number
  rerankerScore?: number
  denseScore?: number
  fusionScore?: number
  lexicalScore?: number
  scoreType?: 'dense' | 'lexical' | 'fusion' | 'reranker' | 'entity-resolution'
  sourceFile?: string
  chunkIndex?: number
  folderId?: string
  folderName?: string
  totalChunks?: number
  documentTitle?: string
  sectionPath?: string
  contentHash?: string
  documentId?: string
  documentRef?: string
  revision?: string
  sourceStart?: number
  sourceEnd?: number
  sourceChunkId?: string
  matchedRepresentations?: Array<'raw' | 'summary' | 'keywords' | 'fact'>
  /** Stable public alias for representation provenance. */
  matchedBy?: Array<'raw' | 'summary' | 'keyword' | 'fact'>
  matchedFacts?: string[]
}

export interface MemoryRetrievalStatusDetails {
  candidateCount?: number
  resultCount?: number
  candidates?: RetrievedChunk[]
}

export interface PreparedMemoryChunk {
  text: string
  searchText: string
  chunkIndex: number
  documentTitle: string
  sectionPath: string
  contentHash: string
  /** Character range in the canonical source text. Internal addressing only. */
  sourceStart?: number
  sourceEnd?: number
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
 * Estimate how many chunks a file will produce without reading or parsing it.
 * File size is used as an approximate character count, so this is intentionally
 * only suitable for displaying a rough pre-indexing value.
 */
export function estimateChunkCountFromFileSize(
  fileSizeBytes: number,
  config: { chunkSize: number; chunkOverlap: number },
): number {
  if (!Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0) return 0

  const chunkCapacity = config.chunkSize * CHARS_PER_TOKEN
  const chunkStride = (config.chunkSize - config.chunkOverlap) * CHARS_PER_TOKEN
  if (chunkCapacity <= 0 || chunkStride <= 0) return 0
  if (fileSizeBytes <= chunkCapacity) return 1

  return 1 + Math.ceil((fileSizeBytes - chunkCapacity) / chunkStride)
}

/**
 * Parser pipeline: chunk → embed → store in LanceDB.
 * Also handles retrieval: embed query → search → return ranked results.
 */
export class MemoryParser {
  private chunkSize: number
  private chunkOverlap: number

  constructor(opts?: { chunkSize?: number; chunkOverlap?: number }) {
    this.chunkSize = opts?.chunkSize ?? MEMORY_CHUNK_SIZE_TOKENS
    this.chunkOverlap = opts?.chunkOverlap ?? MEMORY_CHUNK_OVERLAP_TOKENS
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
    opts?: { signal?: AbortSignal; onProgress?: (current: number, total: number) => void }
  ): Promise<number> {
    throwIfAborted(opts?.signal)
    const chunks = await this.prepareChunks(text, meta.sourceFile)
    throwIfAborted(opts?.signal)
    if (chunks.length === 0) return 0
    opts?.onProgress?.(0, chunks.length)

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

        // Start embedding current batch immediately so it runs concurrently
        // with the previous batch's LanceDB write (sliding-window pipeline).
        const embedPromise = MemoryParser.withRetry(() => embedder.embedBatch(batch.map((item) => item.searchText)))

        // Wait for the previous write to finish, then count it.
        const completedWrite = pendingWrite
        await (completedWrite?.promise ?? Promise.resolve())
        if (completedWrite) {
          totalStored += completedWrite.ids.length
          storedIds.push(...completedWrite.ids)
          opts?.onProgress?.(totalStored, chunks.length)
          pendingWrite = null
        }

        const embeddings = await embedPromise
        throwIfAborted(opts?.signal)

        // Resolve dimensions once; they never change for a given provider.
        if (dimensions === undefined) dimensions = embeddings[0].dimensions
        const dims = dimensions as number

        const docs: VectorDocument[] = batch.map((item, j) => ({
          id: nanoid(),
          text: item.text,
          searchText: item.searchText,
          vector: embeddings[j].vector,
          source: meta.source,
          sourceFile: meta.sourceFile || '',
          chunkIndex: item.chunkIndex,
          folderId: meta.folderId || '',
          createdAt: Date.now(),
          documentTitle,
          sectionPath: item.sectionPath,
          contentHash: item.contentHash,
          sourceStart: item.sourceStart,
          sourceEnd: item.sourceEnd,
          embeddingModel: embeddings[j].model,
          representationType: 'raw',
        }))
        for (const doc of docs) doc.sourceChunkId = doc.id

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
        opts?.onProgress?.(totalStored, chunks.length)
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
    filter?: string,
    onStatus?: (stage: 'rag' | 'reranking', details?: MemoryRetrievalStatusDetails) => void,
  ): Promise<RetrievedChunk[]> {
    const embedder = getEmbeddingProvider()
    const ragStore = getRAGStore()
    const reranker = getMemoryReranker()

    onStatus?.('rag')
    const { vector } = await embedder.embed(query)
    // Search a wider pool because analyzed chunks may have several independent
    // representations. They are collapsed to authoritative chunks below.
    const candidateCount = reranker.getCandidateCount(topK)
    const representationCandidateCount = candidateCount * 4
    const [denseCandidates, lexicalCandidates] = await Promise.all([
      ragStore.search(tableName, vector, representationCandidateCount, filter),
      ragStore.lexicalSearch(tableName, query, representationCandidateCount, filter),
    ])
    const representationResults = fuseRetrievalChannels([denseCandidates, lexicalCandidates], representationCandidateCount)
      .filter((result) => isRetrievableChunk(result.text))
    const results = collapseChunkRepresentations(representationResults, candidateCount)
    onStatus?.('rag', { candidateCount: results.length, candidates: results })
    const reranking = reranker.getConfig().enabled && results.length > 1
    if (reranking) onStatus?.('reranking', { candidateCount: results.length })
    const ranked = await reranker.rerank(query, results, topK).catch((err) => {
      console.warn('[memory-reranker] Rerank failed, using hybrid ranking:', err)
      return results.slice(0, topK)
    })
    if (reranking) onStatus?.('reranking', { candidateCount: results.length, resultCount: ranked.length })
    return ranked.map((r) => ({
      id: r.id,
      text: r.text,
      source: r.source,
      score: r.score,
      rerankerScore: r.rerankerScore,
      denseScore: r.denseScore,
      fusionScore: r.fusionScore,
      lexicalScore: r.lexicalScore,
      scoreType: r.scoreType,
      documentTitle: r.documentTitle,
      sectionPath: r.sectionPath,
      contentHash: r.contentHash,
      sourceStart: r.sourceStart,
      sourceEnd: r.sourceEnd,
      sourceFile: r.sourceFile,
      chunkIndex: r.chunkIndex,
      folderId: r.folderId,
      sourceChunkId: r.sourceChunkId || r.id,
      matchedRepresentations: r.matchedRepresentations,
      matchedBy: r.matchedRepresentations?.map((representation) =>
        representation === 'keywords' ? 'keyword' as const : representation),
      matchedFacts: r.matchedFacts,
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
   * Produce the canonical structural chunks shared by vector indexing and
   * document-grounded claim extraction. Keeping one chunking pass gives graph
   * evidence stable, directly retrievable chunk coordinates.
   */
  async prepareChunks(text: string, sourceFile?: string): Promise<PreparedMemoryChunk[]> {
    const chunks = await this.chunk(text)
    const documentTitle = inferDocumentTitle(text, sourceFile)
    let inheritedSection = documentTitle

    let searchFrom = 0
    return chunks.map((chunk, chunkIndex) => {
      const explicitSection = inferExplicitSectionPath(chunk)
      if (explicitSection) inheritedSection = explicitSection
      const sectionPath = inheritedSection || documentTitle
      const searchText = [
        documentTitle ? `Document: ${documentTitle}` : '',
        sectionPath && sectionPath !== documentTitle ? `Section: ${sectionPath}` : '',
        chunk,
      ].filter(Boolean).join('\n')
      let sourceStart = text.indexOf(chunk, searchFrom)
      if (sourceStart < 0) sourceStart = text.indexOf(chunk)
      if (sourceStart < 0) sourceStart = 0
      const sourceEnd = sourceStart + chunk.length
      // Overlapping chunks may begin before the prior chunk ends. Moving one
      // character forward still distinguishes repeated occurrences in order.
      searchFrom = sourceStart + 1
      return {
        text: chunk,
        searchText,
        chunkIndex,
        documentTitle,
        sectionPath,
        contentHash: createHash('sha256').update(chunk).digest('hex'),
        sourceStart,
        sourceEnd,
      }
    })
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

/** Collapse search-only summary/keyword/fact hits to their authoritative raw
 * chunk. Reciprocal rank contributions reward chunks found through several
 * independent representations without comparing dense and BM25 scales. */
export function collapseChunkRepresentations(results: SearchResult[], limit: number, rankConstant = 60): SearchResult[] {
  const grouped = new Map<string, {
    best: SearchResult
    score: number
    representations: Set<NonNullable<SearchResult['representationType']>>
    facts: Set<string>
  }>()
  results.forEach((result, index) => {
    const sourceChunkId = result.sourceChunkId || result.id
    const representation = result.representationType || 'raw'
    const matchedFact = representation === 'fact' ? result.matchedSearchText?.trim() : undefined
    const contribution = 1 / (rankConstant + index + 1)
    const current = grouped.get(sourceChunkId)
    if (current) {
      current.score += contribution
      current.representations.add(representation)
      if (matchedFact) current.facts.add(matchedFact)
      if (representation === 'raw' && current.best.representationType !== 'raw') current.best = result
    } else {
      grouped.set(sourceChunkId, {
        best: result,
        score: contribution,
        representations: new Set([representation]),
        facts: new Set(matchedFact ? [matchedFact] : []),
      })
    }
  })
  return [...grouped.entries()]
    .map(([sourceChunkId, group]) => ({
      ...group.best,
      id: sourceChunkId,
      sourceChunkId,
      matchedRepresentations: [...group.representations],
      matchedFacts: [...group.facts],
      representationFusionScore: group.score,
    }))
    .sort((a, b) => b.representationFusionScore - a.representationFusionScore)
    .slice(0, limit)
    .map(({ representationFusionScore: _score, ...result }) => result)
}

/**
 * Deterministic reciprocal-rank fusion across independently budgeted channels.
 * Raw dense/BM25 scores remain available for diagnostics; neither is treated
 * as a percentage or compared directly to the other.
 */
export function fuseRetrievalChannels(channels: SearchResult[][], limit: number, rankConstant = 60): SearchResult[] {
  const fused = new Map<string, SearchResult & { fusedScore: number }>()
  for (const channel of channels) {
    channel.forEach((candidate, index) => {
      const contribution = 1 / (rankConstant + index + 1)
      const current = fused.get(candidate.id)
      if (!current) {
        fused.set(candidate.id, { ...candidate, fusedScore: contribution })
        return
      }
      current.fusedScore += contribution
      current.denseScore ??= candidate.denseScore
      current.lexicalScore ??= candidate.lexicalScore
    })
  }

  return Array.from(fused.values())
    .sort((a, b) => b.fusedScore - a.fusedScore || b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit))
    .map(({ fusedScore, ...candidate }) => ({
      ...candidate,
      score: fusedScore,
      fusionScore: fusedScore,
      scoreType: 'fusion' as const,
    }))
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

export function inferDocumentTitle(text: string, sourceFile?: string): string {
  const heading = text.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim()
  if (heading) return heading.slice(0, 240)
  return (sourceFile || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 240)
}

export function inferSectionPath(chunk: string, documentTitle: string): string {
  return inferExplicitSectionPath(chunk) || documentTitle
}

function inferExplicitSectionPath(chunk: string): string {
  const headings = Array.from(chunk.matchAll(/^\s*#{1,6}\s+(.+?)\s*$/gm))
    .map((match) => match[1].trim())
    .filter(Boolean)
  return (headings.at(-1) || '').slice(0, 500)
}

let parserInstance: MemoryParser | null = null

export function getMemoryParser(): MemoryParser {
  if (!parserInstance) {
    parserInstance = new MemoryParser()
  }
  return parserInstance
}
