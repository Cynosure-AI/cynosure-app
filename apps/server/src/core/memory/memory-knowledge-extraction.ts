import { readFileSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { getDb } from '../../db/database.js'
import { isParseableDocument, parseDocument } from '../utils/document-parser.js'
import { extractKnowledgeFromContent, mergeKnowledgeChunkTags } from './knowledge-extractor.js'
import type { KnowledgeExtractionResult as ExtractedKnowledge } from './knowledge-extractor.js'
import {
  getMemoryKnowledgeStore,
  MEMORY_KNOWLEDGE_PIPELINE_VERSION,
  MEMORY_KNOWLEDGE_PROMPT_VERSION,
  type KnowledgeExtractedChunkTags,
  type ReusableKnowledgeChunk,
} from './memory-knowledge.js'
import { PLAIN_TEXT_EXTENSIONS, readTextFile } from './memory-file-manager.js'
import { getMemoryParser, type PreparedMemoryChunk } from './parser.js'
import { getRAGStore } from './rag.js'
import { getActivePermanentMemoryTableName } from './memory-index-manifest.js'
import { andLanceDbFilters, lanceDbEqFilter } from './lancedb-filter.js'

export interface KnowledgeExtractionResult {
  fileName: string
  sourceId: string
  insertedOrUpdated: number
  deleted: number
  knowledgeExtractedAt: number
  documentId: string
  contentHash: string
  tags: string[]
  chunksAnalyzed: number
  chunksReused: number
}

export interface KnowledgeExtractionConfig {
  providerId?: string
  model?: string
}

export interface KnowledgeExtractionCheckpoint extends ExtractedKnowledge {
  contentHash: string
  completedChunkIndexes: number[]
}

const ENTITY_EXTRACTION_SETTINGS_KEY = 'memoryEntityExtraction'

interface ReusableChunkPlan {
  reusableChunks: ReusableKnowledgeChunk[]
  chunkTags: KnowledgeExtractedChunkTags[]
  chunksToExtract: PreparedMemoryChunk[]
}

/** Match exact chunks against the last compatible active extraction. Buckets
 * make duplicate chunks occurrence-aware, while hashes allow unchanged chunks
 * to move when an insertion shifts their numeric indexes. */
export function planReusableKnowledgeChunks(documentId: string, chunks: PreparedMemoryChunk[]): ReusableChunkPlan {
  const priorRun = getDb().prepare(`
    SELECT id FROM memory_knowledge_index_runs
    WHERE document_id = ? AND pipeline_version = ? AND prompt_version = ? AND status = 'active'
    ORDER BY activated_at DESC LIMIT 1
  `).get(documentId, MEMORY_KNOWLEDGE_PIPELINE_VERSION, MEMORY_KNOWLEDGE_PROMPT_VERSION) as { id: string } | undefined
  if (!priorRun) return { reusableChunks: [], chunkTags: [], chunksToExtract: chunks }

  const priorChunks = getDb().prepare(`
    SELECT id, text_hash, tags_json FROM memory_knowledge_text_units
    WHERE run_id = ? ORDER BY chunk_index
  `).all(priorRun.id) as Array<{ id: string; text_hash: string; tags_json: string }>
  const byHash = new Map<string, Array<{ id: string; tags: string[] }>>()
  for (const prior of priorChunks) {
    let tags: string[] = []
    try {
      const parsed = JSON.parse(prior.tags_json) as unknown
      if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === 'string')
    } catch { /* malformed legacy tags are treated as empty */ }
    const bucket = byHash.get(prior.text_hash)
    if (bucket) bucket.push({ id: prior.id, tags })
    else byHash.set(prior.text_hash, [{ id: prior.id, tags }])
  }

  const reusableChunks: ReusableKnowledgeChunk[] = []
  const chunkTags: KnowledgeExtractedChunkTags[] = []
  const chunksToExtract: PreparedMemoryChunk[] = []
  for (const chunk of chunks) {
    const matches = byHash.get(chunk.contentHash)
    const match = matches?.shift()
    if (!match) {
      chunksToExtract.push(chunk)
      continue
    }
    reusableChunks.push({ sourceChunkIndex: chunk.chunkIndex, priorTextUnitId: match.id })
    chunkTags.push({ sourceChunkIndex: chunk.chunkIndex, tags: match.tags })
  }
  return { reusableChunks, chunkTags, chunksToExtract }
}
/** Extract each canonical RAG chunk independently. Entity-rich documents can
 * produce much more JSON than source text, so combining chunks risks hitting
 * the model's output limit. One chunk per batch also gives users meaningful,
 * predictable progress without relying on automatic retries. */
function buildEntityExtractionSegments(chunks: PreparedMemoryChunk[]) {
  return chunks.map((chunk) => ({
    chunkIndex: chunk.chunkIndex,
    chunkIndexes: [chunk.chunkIndex],
    content: [
      `Document: ${chunk.documentTitle}`,
      `<source_chunk index="${chunk.chunkIndex}" section="${chunk.sectionPath.replace(/"/g, '&quot;')}">`,
      chunk.text,
      '</source_chunk>',
    ].join('\n'),
  }))
}

function normalizeEntityExtractionConfig(config: Partial<KnowledgeExtractionConfig> | undefined): KnowledgeExtractionConfig {
  return {
    providerId: config?.providerId?.trim() || undefined,
    model: config?.model?.trim() || undefined,
  }
}

export function getKnowledgeExtractionConfig(): KnowledgeExtractionConfig {
  try {
    const row = getDb()
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get(ENTITY_EXTRACTION_SETTINGS_KEY) as { value_json: string } | undefined
    if (!row) return {}
    return normalizeEntityExtractionConfig(JSON.parse(row.value_json) as Partial<KnowledgeExtractionConfig>)
  } catch {
    return {}
  }
}

export function saveKnowledgeExtractionConfig(config: Partial<KnowledgeExtractionConfig>): KnowledgeExtractionConfig {
  const normalized = normalizeEntityExtractionConfig(config)
  getDb()
    .prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)')
    .run(ENTITY_EXTRACTION_SETTINGS_KEY, JSON.stringify(normalized))
  return normalized
}

export function memoryKnowledgeSourceId(spaceId: string, fileName: string): string {
  return `memory:${spaceId}:${fileName}`
}

export function markMemoryFileKnowledgeExtracted(
  spaceId: string,
  fileName: string,
  indexedAt = Date.now(),
  expectedContentHash?: string,
  tags: string[] = [],
): boolean {
  const tagsJson = JSON.stringify(tags)
  const result = expectedContentHash
    ? getDb().prepare(`
        UPDATE memory_file_index SET knowledge_extracted_at = ?, tags_json = ?
        WHERE space_id = ? AND file_name = ? AND content_hash = ?
      `).run(indexedAt, tagsJson, spaceId, fileName, expectedContentHash)
    : getDb().prepare(`
        UPDATE memory_file_index SET knowledge_extracted_at = ?, tags_json = ?
        WHERE space_id = ? AND file_name = ?
      `).run(indexedAt, tagsJson, spaceId, fileName)
  return result.changes > 0
}

export function moveMemoryKnowledgeSource(sourceSpaceId: string, sourceFileName: string, targetSpaceId: string, targetFileName: string): void {
  const newSourceId = memoryKnowledgeSourceId(targetSpaceId, targetFileName)
  const db = getDb()
  let knowledgeDocumentId: string | undefined
  if (sourceSpaceId !== targetSpaceId) {
    knowledgeDocumentId = (db.prepare(`
      SELECT document_id FROM memory_knowledge_index_runs
      WHERE space_id = ? AND file_name = ? AND status = 'active'
      ORDER BY activated_at DESC LIMIT 1
    `).get(sourceSpaceId, sourceFileName) as { document_id: string } | undefined)?.document_id
    if (knowledgeDocumentId) getMemoryKnowledgeStore().retireDocument(knowledgeDocumentId)
    db.prepare(`UPDATE memory_file_index SET knowledge_extracted_at = 0, tags_json = '[]' WHERE space_id = ? AND file_name = ?`).run(targetSpaceId, targetFileName)
    return
  }
  db.transaction(() => {
    knowledgeDocumentId = (db.prepare(`
      SELECT document_id FROM memory_knowledge_index_runs
      WHERE space_id = ? AND file_name = ? AND status = 'active'
      ORDER BY activated_at DESC LIMIT 1
    `).get(sourceSpaceId, sourceFileName) as { document_id: string } | undefined)?.document_id
    db.prepare(`
      UPDATE memory_knowledge_index_runs
      SET space_id = ?, file_name = ?, source_id = ?
      WHERE space_id = ? AND file_name = ?
    `).run(targetSpaceId, targetFileName, newSourceId, sourceSpaceId, sourceFileName)
    db.prepare(`
      UPDATE memory_knowledge_text_units
      SET space_id = ?, file_name = ?
      WHERE space_id = ? AND file_name = ?
    `).run(targetSpaceId, targetFileName, sourceSpaceId, sourceFileName)
  })()
  if (knowledgeDocumentId) {
    void getMemoryKnowledgeStore().reindexActiveDocumentProjection(knowledgeDocumentId).catch((error) => {
      console.warn('[memory] Failed to refresh moved knowledge vector projection:', error)
    })
  }
}

export function deleteMemoryKnowledgeSource(spaceId: string, fileName: string): { edgesDeleted: number; orphanedNodeIds: string[] } {
  let document = getDb().prepare(`
    SELECT document_id FROM memory_file_index WHERE space_id = ? AND file_name = ?
  `).get(spaceId, fileName) as { document_id: string } | undefined
  if (!document) {
    document = getDb().prepare(`
      SELECT document_id FROM memory_knowledge_index_runs
      WHERE space_id = ? AND file_name = ? AND status = 'active'
      ORDER BY activated_at DESC LIMIT 1
    `).get(spaceId, fileName) as { document_id: string } | undefined
  }
  const before = document?.document_id
    ? Number((getDb().prepare(`SELECT COUNT(DISTINCT ev.assertion_id) AS count FROM memory_knowledge_assertion_evidence ev JOIN memory_knowledge_index_runs r ON r.id = ev.run_id WHERE r.document_id = ? AND r.status = 'active'`).get(document.document_id) as { count: number } | undefined)?.count || 0)
    : 0
  if (document?.document_id) getMemoryKnowledgeStore().retireDocument(document.document_id)
  return { edgesDeleted: before, orphanedNodeIds: [] }
}

/** Retire every active knowledge revision sourced from a memory space. */
export function deleteMemoryKnowledgeSpace(spaceId: string): { edgesDeleted: number; orphanedNodeIds: string[] } {
  const edgesDeleted = Number((getDb().prepare(`SELECT COUNT(DISTINCT ev.assertion_id) AS count FROM memory_knowledge_assertion_evidence ev JOIN memory_knowledge_index_runs r ON r.id = ev.run_id WHERE r.space_id = ? AND r.status = 'active'`).get(spaceId) as { count: number } | undefined)?.count || 0)
  const documents = getDb().prepare(`
    SELECT DISTINCT document_id FROM memory_knowledge_index_runs WHERE space_id = ? AND status = 'active'
  `).all(spaceId) as Array<{ document_id: string }>
  for (const document of documents) getMemoryKnowledgeStore().retireDocument(document.document_id)
  return { edgesDeleted, orphanedNodeIds: [] }
}

export async function readMemoryFileForKnowledgeExtraction(folderPath: string, fileName: string): Promise<string> {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
  if (PLAIN_TEXT_EXTENSIONS.has(ext)) {
    return readTextFile(folderPath, fileName)
  }
  if (isParseableDocument(fileName)) {
    return parseDocument(readFileSync(join(folderPath, fileName)), fileName)
  }
  throw new Error(`Unsupported file type: ${ext}`)
}

export async function indexMemoryContentIntoKnowledge(opts: {
  content: string
  spaceId: string
  fileName: string
  replaceExisting?: boolean
  providerId?: string
  model?: string
  signal?: AbortSignal
  onExtractionProgress?: (current: number, total: number) => void
  resumeCheckpoint?: KnowledgeExtractionCheckpoint
  onExtractionCheckpoint?: (checkpoint: KnowledgeExtractionCheckpoint, current: number, total: number) => void
}): Promise<KnowledgeExtractionResult> {
  const knowledge = getMemoryKnowledgeStore()
  const resetGeneration = knowledge.getResetGeneration()
  const contentHash = createHash('sha256').update(opts.content).digest('hex')
  const indexedDocument = getDb().prepare(`
    SELECT document_id, content_hash
    FROM memory_file_index
    WHERE space_id = ? AND file_name = ?
  `).get(opts.spaceId, opts.fileName) as { document_id: string; content_hash: string } | undefined
  if (!indexedDocument || indexedDocument.content_hash !== contentHash) {
    throw new Error('MEMORY_DOCUMENT_NOT_CURRENTLY_INDEXED')
  }

  const sourceId = memoryKnowledgeSourceId(opts.spaceId, opts.fileName)
  const configuredTarget = getKnowledgeExtractionConfig()
  const chunks = await getMemoryParser().prepareChunks(opts.content, opts.fileName)
  if (chunks.length === 0) {
    if (opts.replaceExisting !== false) deleteMemoryKnowledgeSource(opts.spaceId, opts.fileName)
    getMemoryKnowledgeStore().retireDocument(indexedDocument.document_id)
    const knowledgeExtractedAt = Date.now()
    markMemoryFileKnowledgeExtracted(opts.spaceId, opts.fileName, knowledgeExtractedAt, contentHash)
    return {
      fileName: opts.fileName,
      sourceId,
      insertedOrUpdated: 0,
      deleted: 0,
      knowledgeExtractedAt,
      documentId: indexedDocument.document_id,
      contentHash,
      tags: [],
      chunksAnalyzed: 0,
      chunksReused: 0,
    }
  }
  const reusePlan = planReusableKnowledgeChunks(indexedDocument.document_id, chunks)
  const resumable = opts.resumeCheckpoint?.contentHash === contentHash ? opts.resumeCheckpoint : undefined
  const extractableIndexes = new Set(reusePlan.chunksToExtract.map((chunk) => chunk.chunkIndex))
  const completedIndexes = new Set((resumable?.completedChunkIndexes || []).filter((index) => extractableIndexes.has(index)))
  const remainingChunks = reusePlan.chunksToExtract.filter((chunk) => !completedIndexes.has(chunk.chunkIndex))
  let checkpointStep = 0
  const extracted = remainingChunks.length > 0
    ? await extractKnowledgeFromContent({
        segments: buildEntityExtractionSegments(remainingChunks),
        providerId: opts.providerId || configuredTarget.providerId,
        model: opts.model || configuredTarget.model,
        signal: opts.signal,
        initialResult: resumable,
        onCheckpoint: (partial) => {
          const completedChunk = remainingChunks[checkpointStep++]
          if (completedChunk) completedIndexes.add(completedChunk.chunkIndex)
          const checkpoint: KnowledgeExtractionCheckpoint = {
            contentHash,
            completedChunkIndexes: [...completedIndexes].sort((a, b) => a - b),
            ...partial,
          }
          opts.onExtractionCheckpoint?.(checkpoint, completedIndexes.size, reusePlan.chunksToExtract.length)
        },
        onProgress: (_current, _total) => opts.onExtractionProgress?.(completedIndexes.size, reusePlan.chunksToExtract.length),
      })
    : resumable || { relations: [], mentions: [], chunkTags: [] }
  const chunkTags = [...reusePlan.chunkTags, ...extracted.chunkTags]
  opts.signal?.throwIfAborted()
  if (knowledge.getResetGeneration() !== resetGeneration) {
    throw new DOMException('Knowledge was reset during extraction', 'AbortError')
  }
  const knowledgeResult = knowledge.publishDocument({
    documentId: indexedDocument.document_id,
    contentHash,
    spaceId: opts.spaceId,
    fileName: opts.fileName,
    sourceId,
    chunks,
    relations: extracted.relations,
    mentions: extracted.mentions,
    chunkTags,
    reusableChunks: reusePlan.reusableChunks,
    extractorProviderId: opts.providerId || configuredTarget.providerId,
    extractorModel: opts.model || configuredTarget.model,
    validateBeforePublish: () => {
      const current = getDb().prepare(`
        SELECT content_hash FROM memory_file_index
        WHERE space_id = ? AND file_name = ?
      `).get(opts.spaceId, opts.fileName) as { content_hash: string } | undefined
      return current?.content_hash === contentHash
    },
  })
  await knowledge.indexSearchProjection(knowledgeResult.runId, opts.signal)
  opts.signal?.throwIfAborted()
  if (knowledge.getResetGeneration() !== resetGeneration) {
    throw new DOMException('Knowledge was reset during extraction', 'AbortError')
  }
  const tags = mergeKnowledgeChunkTags(chunkTags)
  const extractedTagsByChunk = new Map(chunkTags.map((item) => [item.sourceChunkIndex, item.tags]))
  const chunkSearchKeywords = new Map(chunks.map((chunk) => [chunk.chunkIndex, {
    contentHash: chunk.contentHash,
    keywords: extractedTagsByChunk.get(chunk.chunkIndex) || [],
  }]))
  const chunkFilter = andLanceDbFilters(
    lanceDbEqFilter('spaceId', opts.spaceId),
    lanceDbEqFilter('sourceFile', opts.fileName),
  )
  if (chunkFilter) {
    await getRAGStore().updateChunkSearchKeywords(
      getActivePermanentMemoryTableName(),
      chunkFilter,
      chunkSearchKeywords,
    )
  }
  opts.signal?.throwIfAborted()
  const knowledgeExtractedAt = Date.now()
  if (!markMemoryFileKnowledgeExtracted(opts.spaceId, opts.fileName, knowledgeExtractedAt, contentHash, tags)) {
    // A concurrent edit landed after extraction committed. Remove the now-stale
    // version only; never delete a newer extraction that may already exist.
    knowledge.retireRun(knowledgeResult.runId)
    throw new Error('MEMORY_KNOWLEDGE_SOURCE_CHANGED')
  }
  return {
    fileName: opts.fileName,
    sourceId,
    insertedOrUpdated: knowledgeResult.assertions,
    deleted: 0,
    knowledgeExtractedAt,
    documentId: indexedDocument.document_id,
    contentHash,
    tags,
    chunksAnalyzed: reusePlan.chunksToExtract.length,
    chunksReused: reusePlan.reusableChunks.length,
  }
}

export async function indexMemoryFileIntoKnowledge(opts: {
  folderPath: string
  spaceId: string
  fileName: string
  replaceExisting?: boolean
  providerId?: string
  model?: string
  signal?: AbortSignal
  onExtractionProgress?: (current: number, total: number) => void
  resumeCheckpoint?: KnowledgeExtractionCheckpoint
  onExtractionCheckpoint?: (checkpoint: KnowledgeExtractionCheckpoint, current: number, total: number) => void
}): Promise<KnowledgeExtractionResult> {
  const content = await readMemoryFileForKnowledgeExtraction(opts.folderPath, opts.fileName)
  return indexMemoryContentIntoKnowledge({ ...opts, content })
}
