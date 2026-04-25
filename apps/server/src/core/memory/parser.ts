import { nanoid } from 'nanoid'
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { getEmbeddingProvider } from './embedding.js'
import { getRAGStore, type VectorDocument } from './rag.js'
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
  sourceFile?: string
  chunkIndex?: number
  spaceId?: string
  spaceName?: string
  totalChunks?: number
}

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
        if (cfg.chunkSize && cfg.chunkSize >= 100) this.chunkSize = cfg.chunkSize
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
   * fails, the function returns the count of chunks stored so far rather
   * than throwing, so callers always get a usable partial result.
   */
  async ingest(
    tableName: string,
    text: string,
    meta: DocumentMeta
  ): Promise<number> {
    const chunks = await this.chunk(text)
    if (chunks.length === 0) return 0

    const embedder = getEmbeddingProvider()
    const ragStore = getRAGStore()
    const BATCH_SIZE = 32
    let totalStored = 0
    let dimensions: number | undefined

    // pendingWrite tracks the in-flight LanceDB write and its chunk count so
    // we can overlap it with the next embedding batch (sliding-window pipeline)
    // and only increment totalStored once the write is confirmed.
    let pendingWrite: { promise: Promise<void>; count: number } | null = null

    try {
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE)

        // Start embedding current batch immediately so it runs concurrently
        // with the previous batch's LanceDB write (sliding-window pipeline).
        const embedPromise = MemoryParser.withRetry(() => embedder.embedBatch(batch))

        // Wait for the previous write to finish, then count it.
        await (pendingWrite?.promise ?? Promise.resolve())
        if (pendingWrite) totalStored += pendingWrite.count

        const embeddings = await embedPromise

        // Resolve dimensions once; they never change for a given provider.
        if (dimensions === undefined) dimensions = embeddings[0].dimensions
        const dims = dimensions as number

        const docs: VectorDocument[] = batch.map((chunk, j) => ({
          id: nanoid(),
          text: chunk,
          vector: embeddings[j].vector,
          source: meta.source,
          sourceFile: meta.sourceFile || '',
          chunkIndex: i + j,
          spaceId: meta.spaceId || '',
          createdAt: Date.now()
        }))

        pendingWrite = {
          promise: MemoryParser.withRetry(() => ragStore.addDocuments(tableName, docs, dims)),
          count: docs.length
        }
      }

      // Flush the last in-flight write.
      if (pendingWrite) {
        await pendingWrite.promise
        totalStored += pendingWrite.count
      }
    } catch (err) {
      // Ensure any in-flight write is settled so totalStored reflects reality
      // before we log and return the partial count.
      if (pendingWrite) {
        try {
          await pendingWrite.promise
          totalStored += pendingWrite.count
        } catch {
          // Write also failed — totalStored already reflects what we know succeeded
        }
      }
      console.error(`[MemoryParser] ingest aborted after storing ${totalStored} chunks:`, err)
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

    const { vector } = await embedder.embed(query)
    const results = await ragStore.hybridSearch(tableName, vector, query, topK, filter)

    return results.map((r) => ({
      id: r.id,
      text: r.text,
      source: r.source,
      score: r.score,
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
    if (trimmed.length <= this.chunkSize) return [trimmed]

    const splitter = RecursiveCharacterTextSplitter.fromLanguage('markdown', {
      chunkSize: this.chunkSize,
      chunkOverlap: this.chunkOverlap,
    })

    const docs = await splitter.createDocuments([trimmed])
    const raw = docs.map(d => d.pageContent).filter(c => c.trim().length > 0)
    return this.mergeHeadingOnlyChunks(raw)
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

let parserInstance: MemoryParser | null = null

export function getMemoryParser(): MemoryParser {
  if (!parserInstance) {
    parserInstance = new MemoryParser()
    parserInstance.refreshConfig()
  }
  return parserInstance
}
