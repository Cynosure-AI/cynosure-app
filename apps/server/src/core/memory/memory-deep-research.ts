import { readFileSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { getDb } from '../../db/database.js'
import { isParseableDocument, parseDocument } from '../utils/document-parser.js'
import { deepResearchContent, mergeDeepResearchChunkTags } from './deep-research-extractor.js'
import type { DeepResearchResult as DeepResearchedKnowledge } from './deep-research-extractor.js'
import { MAX_ANALYSIS_CHUNKS } from '../runtime-limits.js'

import {
  getMemoryKnowledgeStore,
  MEMORY_KNOWLEDGE_PIPELINE_VERSION,
  MEMORY_KNOWLEDGE_PROMPT_VERSION,
  type DeepResearchExtractedChunkSummary,
  type DeepResearchExtractedChunkTags,
  type ReusableKnowledgeChunk,
} from './memory-knowledge.js'
import { PLAIN_TEXT_EXTENSIONS, readTextFile } from './memory-file-manager.js'
import { getMemoryParser, type PreparedMemoryChunk } from './parser.js'
import { getRAGStore } from './rag.js'
import { getActivePermanentMemoryTableName } from './memory-index-manifest.js'
import { andLanceDbFilters, lanceDbEqFilter } from './lancedb-filter.js'

export interface DeepResearchResult {
  fileName: string
  sourceId: string
  insertedOrUpdated: number
  deleted: number
  deepResearchedAt: number
  documentId: string
  contentHash: string
  tags: string[]
  chunksDeepResearched: number
  chunksReused: number
}

export interface DeepResearchConfig {
  providerId?: string
  model?: string
}

export interface DeepResearchCheckpoint extends DeepResearchedKnowledge {
  contentHash: string
  completedChunkIndexes: number[]
}

const DEEP_RESEARCH_SETTINGS_KEY = 'memoryDeepResearch'

interface ReusableChunkPlan {
  reusableChunks: ReusableKnowledgeChunk[]
  chunkTags: DeepResearchExtractedChunkTags[]
  chunkSummaries: DeepResearchExtractedChunkSummary[]
  chunksToExtract: PreparedMemoryChunk[]
}

export interface MemorySourceRange {
  start: number
  end: number
}

/** Resolve edited source ranges to the current chunk layout and include one
 * neighboring chunk on either side. Chunk boundaries can shift after an edit,
 * so ranges that land between chunks are assigned to the nearest chunk. */
export function affectedChunkNeighborhood(
  chunks: PreparedMemoryChunk[],
  ranges: MemorySourceRange[],
  radius = 1,
): Set<number> {
  const affected = new Set<number>()
  if (!chunks.length) return affected

  for (const range of ranges) {
    const start = Math.max(0, Math.min(range.start, range.end))
    const end = Math.max(start, Math.max(range.start, range.end))
    const center = start + ((end - start) / 2)
    const overlapping = chunks.filter((chunk) => {
      const chunkStart = chunk.sourceStart ?? 0
      const chunkEnd = chunk.sourceEnd ?? chunkStart + chunk.text.length
      return end === start
        ? chunkStart <= start && chunkEnd >= start
        : chunkStart < end && chunkEnd > start
    })
    const anchors = overlapping.length ? overlapping : [chunks.reduce((nearest, chunk) => {
      const chunkStart = chunk.sourceStart ?? 0
      const chunkEnd = chunk.sourceEnd ?? chunkStart + chunk.text.length
      const distance = center < chunkStart ? chunkStart - center : center > chunkEnd ? center - chunkEnd : 0
      const nearestStart = nearest.sourceStart ?? 0
      const nearestEnd = nearest.sourceEnd ?? nearestStart + nearest.text.length
      const nearestDistance = center < nearestStart ? nearestStart - center : center > nearestEnd ? center - nearestEnd : 0
      return distance < nearestDistance ? chunk : nearest
    })]

    for (const anchor of anchors) {
      for (let index = anchor.chunkIndex - radius; index <= anchor.chunkIndex + radius; index++) {
        if (index >= 0 && index < chunks.length) affected.add(index)
      }
    }
  }
  return affected
}

/** Match exact chunks against the last compatible active extraction. Buckets
 * make duplicate chunks occurrence-aware, while hashes allow unchanged chunks
 * to move when an insertion shifts their numeric indexes. */
export function planReusableKnowledgeChunks(
  documentId: string,
  chunks: PreparedMemoryChunk[],
  forceExtractChunkIndexes: ReadonlySet<number> = new Set(),
): ReusableChunkPlan {
  const priorRun = getDb().prepare(`
    SELECT id FROM memory_knowledge_index_runs
    WHERE document_id = ? AND pipeline_version = ? AND prompt_version = ? AND status = 'active'
    ORDER BY activated_at DESC LIMIT 1
  `).get(documentId, MEMORY_KNOWLEDGE_PIPELINE_VERSION, MEMORY_KNOWLEDGE_PROMPT_VERSION) as { id: string } | undefined
  if (!priorRun) return { reusableChunks: [], chunkTags: [], chunkSummaries: [], chunksToExtract: chunks }

  const priorChunks = getDb().prepare(`
    SELECT id, text_hash, tags_json, summary FROM memory_knowledge_text_units
    WHERE run_id = ? ORDER BY chunk_index
  `).all(priorRun.id) as Array<{ id: string; text_hash: string; tags_json: string; summary: string }>
  const byHash = new Map<string, Array<{ id: string; tags: string[]; summary: string }>>()
  for (const prior of priorChunks) {
    let tags: string[] = []
    try {
      const parsed = JSON.parse(prior.tags_json) as unknown
      if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === 'string')
    } catch { /* malformed tags are treated as empty */ }
    const bucket = byHash.get(prior.text_hash)
    if (bucket) bucket.push({ id: prior.id, tags, summary: prior.summary })
    else byHash.set(prior.text_hash, [{ id: prior.id, tags, summary: prior.summary }])
  }

  const reusableChunks: ReusableKnowledgeChunk[] = []
  const chunkTags: DeepResearchExtractedChunkTags[] = []
  const chunkSummaries: DeepResearchExtractedChunkSummary[] = []
  const chunksToExtract: PreparedMemoryChunk[] = []
  for (const chunk of chunks) {
    const matches = byHash.get(chunk.contentHash)
    const match = matches?.shift()
    if (!match || forceExtractChunkIndexes.has(chunk.chunkIndex)) {
      chunksToExtract.push(chunk)
      continue
    }
    reusableChunks.push({ sourceChunkIndex: chunk.chunkIndex, priorTextUnitId: match.id })
    chunkTags.push({ sourceChunkIndex: chunk.chunkIndex, tags: match.tags })
    if (match.summary) chunkSummaries.push({ sourceChunkIndex: chunk.chunkIndex, summary: match.summary })
  }
  return { reusableChunks, chunkTags, chunkSummaries, chunksToExtract }
}
/** Extract each canonical RAG chunk independently. Entity-rich documents can
 * produce much more JSON than source text, so combining chunks risks hitting
 * the model's output limit. One chunk per batch also gives users meaningful,
 * predictable progress without relying on automatic retries. */
function buildDeepResearchSegments(chunks: PreparedMemoryChunk[]) {
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

function normalizeDeepResearchConfig(config: Partial<DeepResearchConfig> | undefined): DeepResearchConfig {
  return {
    providerId: config?.providerId?.trim() || undefined,
    model: config?.model?.trim() || undefined,
  }
}

export function getDeepResearchConfig(): DeepResearchConfig {
  try {
    const row = getDb()
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get(DEEP_RESEARCH_SETTINGS_KEY) as { value_json: string } | undefined
    if (!row) return {}
    return normalizeDeepResearchConfig(JSON.parse(row.value_json) as Partial<DeepResearchConfig>)
  } catch {
    return {}
  }
}

export function saveDeepResearchConfig(config: Partial<DeepResearchConfig>): DeepResearchConfig {
  const normalized = normalizeDeepResearchConfig(config)
  getDb()
    .prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)')
    .run(DEEP_RESEARCH_SETTINGS_KEY, JSON.stringify(normalized))
  return normalized
}

export function memoryKnowledgeSourceId(categoryId: string, fileName: string): string {
  return `memory:${categoryId}:${fileName}`
}

export function markMemoryFileDeepResearched(
  categoryId: string,
  fileName: string,
  indexedAt = Date.now(),
  expectedContentHash?: string,
  tags: string[] = [],
): boolean {
  const tagsJson = JSON.stringify(tags)
  const result = expectedContentHash
    ? getDb().prepare(`
        UPDATE memory_file_index SET deep_researched_at = ?, tags_json = ?
        WHERE category_id = ? AND file_name = ? AND content_hash = ?
      `).run(indexedAt, tagsJson, categoryId, fileName, expectedContentHash)
    : getDb().prepare(`
        UPDATE memory_file_index SET deep_researched_at = ?, tags_json = ?
        WHERE category_id = ? AND file_name = ?
      `).run(indexedAt, tagsJson, categoryId, fileName)
  return result.changes > 0
}

export function moveMemoryKnowledgeSource(sourceCategoryId: string, sourceFileName: string, targetCategoryId: string, targetFileName: string): void {
  const newSourceId = memoryKnowledgeSourceId(targetCategoryId, targetFileName)
  const db = getDb()
  let knowledgeDocumentId: string | undefined
  if (sourceCategoryId !== targetCategoryId) {
    knowledgeDocumentId = (db.prepare(`
      SELECT document_id FROM memory_knowledge_index_runs
      WHERE category_id = ? AND file_name = ? AND status = 'active'
      ORDER BY activated_at DESC LIMIT 1
    `).get(sourceCategoryId, sourceFileName) as { document_id: string } | undefined)?.document_id
    if (knowledgeDocumentId) getMemoryKnowledgeStore().retireDocument(knowledgeDocumentId)
    db.prepare(`UPDATE memory_file_index SET deep_researched_at = 0, tags_json = '[]' WHERE category_id = ? AND file_name = ?`).run(targetCategoryId, targetFileName)
    return
  }
  db.transaction(() => {
    knowledgeDocumentId = (db.prepare(`
      SELECT document_id FROM memory_knowledge_index_runs
      WHERE category_id = ? AND file_name = ? AND status = 'active'
      ORDER BY activated_at DESC LIMIT 1
    `).get(sourceCategoryId, sourceFileName) as { document_id: string } | undefined)?.document_id
    db.prepare(`
      UPDATE memory_knowledge_index_runs
      SET category_id = ?, file_name = ?, source_id = ?
      WHERE category_id = ? AND file_name = ?
    `).run(targetCategoryId, targetFileName, newSourceId, sourceCategoryId, sourceFileName)
    db.prepare(`
      UPDATE memory_knowledge_text_units
      SET category_id = ?, file_name = ?
      WHERE category_id = ? AND file_name = ?
    `).run(targetCategoryId, targetFileName, sourceCategoryId, sourceFileName)
  })()
  if (knowledgeDocumentId) {
    void getMemoryKnowledgeStore().reindexActiveDocumentProjection(knowledgeDocumentId).catch((error) => {
      console.warn('[memory] Failed to refresh moved knowledge vector projection:', error)
    })
  }
}

export function deleteMemoryKnowledgeSource(categoryId: string, fileName: string): { edgesDeleted: number; orphanedNodeIds: string[] } {
  let document = getDb().prepare(`
    SELECT document_id FROM memory_file_index WHERE category_id = ? AND file_name = ?
  `).get(categoryId, fileName) as { document_id: string } | undefined
  if (!document) {
    document = getDb().prepare(`
      SELECT document_id FROM memory_knowledge_index_runs
      WHERE category_id = ? AND file_name = ? AND status = 'active'
      ORDER BY activated_at DESC LIMIT 1
    `).get(categoryId, fileName) as { document_id: string } | undefined
  }
  const before = document?.document_id
    ? Number((getDb().prepare(`SELECT COUNT(DISTINCT ev.assertion_id) AS count FROM memory_knowledge_assertion_evidence ev JOIN memory_knowledge_index_runs r ON r.id = ev.run_id WHERE r.document_id = ? AND r.status = 'active'`).get(document.document_id) as { count: number } | undefined)?.count || 0)
    : 0
  if (document?.document_id) getMemoryKnowledgeStore().retireDocument(document.document_id)
  return { edgesDeleted: before, orphanedNodeIds: [] }
}

/** Retire every active knowledge revision sourced from a memory folder. */
export function deleteMemoryKnowledgeCategory(categoryId: string): { edgesDeleted: number; orphanedNodeIds: string[] } {
  const edgesDeleted = Number((getDb().prepare(`SELECT COUNT(DISTINCT ev.assertion_id) AS count FROM memory_knowledge_assertion_evidence ev JOIN memory_knowledge_index_runs r ON r.id = ev.run_id WHERE r.category_id = ? AND r.status = 'active'`).get(categoryId) as { count: number } | undefined)?.count || 0)
  const documents = getDb().prepare(`
    SELECT DISTINCT document_id FROM memory_knowledge_index_runs WHERE category_id = ? AND status = 'active'
  `).all(categoryId) as Array<{ document_id: string }>
  for (const document of documents) getMemoryKnowledgeStore().retireDocument(document.document_id)
  return { edgesDeleted, orphanedNodeIds: [] }
}

export async function readMemoryFileForDeepResearch(directoryPath: string, fileName: string): Promise<string> {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
  if (PLAIN_TEXT_EXTENSIONS.has(ext)) {
    return readTextFile(directoryPath, fileName)
  }
  if (isParseableDocument(fileName)) {
    return parseDocument(readFileSync(join(directoryPath, fileName)), fileName)
  }
  throw new Error(`Unsupported file type: ${ext}`)
}

export async function deepResearchMemoryContent(opts: {
  content: string
  categoryId: string
  fileName: string
  replaceExisting?: boolean
  providerId?: string
  model?: string
  signal?: AbortSignal
  onDeepResearchProgress?: (current: number, total: number) => void
  resumeCheckpoint?: DeepResearchCheckpoint
  onDeepResearchCheckpoint?: (checkpoint: DeepResearchCheckpoint, current: number, total: number) => void
  /** Canonical ranges changed by memory_patch, expressed against `content`. */
  affectedRanges?: MemorySourceRange[]
}): Promise<DeepResearchResult> {
  const knowledge = getMemoryKnowledgeStore()
  const resetGeneration = knowledge.getResetGeneration()
  const contentHash = createHash('sha256').update(opts.content).digest('hex')
  const indexedDocument = getDb().prepare(`
    SELECT document_id, content_hash
    FROM memory_file_index
    WHERE category_id = ? AND file_name = ?
  `).get(opts.categoryId, opts.fileName) as { document_id: string; content_hash: string } | undefined
  if (!indexedDocument || indexedDocument.content_hash !== contentHash) {
    throw new Error('MEMORY_DOCUMENT_NOT_CURRENTLY_INDEXED')
  }

  const sourceId = memoryKnowledgeSourceId(opts.categoryId, opts.fileName)
  const configuredTarget = getDeepResearchConfig()
  const chunks = await getMemoryParser().prepareChunks(opts.content, opts.fileName)
  if (chunks.length > MAX_ANALYSIS_CHUNKS) {
    throw new Error(`Analysis supports at most ${MAX_ANALYSIS_CHUNKS} chunks; this document has ${chunks.length}.`)
  }
  if (chunks.length === 0) {
    if (opts.replaceExisting !== false) deleteMemoryKnowledgeSource(opts.categoryId, opts.fileName)
    getMemoryKnowledgeStore().retireDocument(indexedDocument.document_id)
    const deepResearchedAt = Date.now()
    markMemoryFileDeepResearched(opts.categoryId, opts.fileName, deepResearchedAt, contentHash)
    return {
      fileName: opts.fileName,
      sourceId,
      insertedOrUpdated: 0,
      deleted: 0,
      deepResearchedAt,
      documentId: indexedDocument.document_id,
      contentHash,
      tags: [],
      chunksDeepResearched: 0,
      chunksReused: 0,
    }
  }
  const forcedChunkIndexes = affectedChunkNeighborhood(chunks, opts.affectedRanges || [])
  const reusePlan = planReusableKnowledgeChunks(indexedDocument.document_id, chunks, forcedChunkIndexes)
  const resumable = opts.resumeCheckpoint?.contentHash === contentHash ? opts.resumeCheckpoint : undefined
  const extractableIndexes = new Set(reusePlan.chunksToExtract.map((chunk) => chunk.chunkIndex))
  const resumableSummaryIndexes = new Set((resumable?.chunkSummaries || []).filter((item) => item.summary.trim()).map((item) => item.sourceChunkIndex))
  const completedIndexes = new Set((resumable?.completedChunkIndexes || []).filter((index) => extractableIndexes.has(index) && resumableSummaryIndexes.has(index)))
  const resumableResult = resumable ? {
    relations: resumable.relations.filter((item) => item.sourceChunkIndex !== undefined && completedIndexes.has(item.sourceChunkIndex)),
    mentions: resumable.mentions.filter((item) => completedIndexes.has(item.sourceChunkIndex)),
    chunkTags: resumable.chunkTags.filter((item) => completedIndexes.has(item.sourceChunkIndex)),
    chunkSummaries: (resumable.chunkSummaries || []).filter((item) => completedIndexes.has(item.sourceChunkIndex)),
  } : undefined
  const remainingChunks = reusePlan.chunksToExtract.filter((chunk) => !completedIndexes.has(chunk.chunkIndex))
  let checkpointStep = 0
  const extracted = remainingChunks.length > 0
    ? await deepResearchContent({
      segments: buildDeepResearchSegments(remainingChunks),
      providerId: opts.providerId || configuredTarget.providerId,
      model: opts.model || configuredTarget.model,
      signal: opts.signal,
      initialResult: resumableResult,
      onCheckpoint: (partial) => {
        const completedChunk = remainingChunks[checkpointStep++]
        if (completedChunk && partial.chunkSummaries.some((item) => item.sourceChunkIndex === completedChunk.chunkIndex && item.summary.trim())) {
          completedIndexes.add(completedChunk.chunkIndex)
        }
        const checkpoint: DeepResearchCheckpoint = {
          contentHash,
          completedChunkIndexes: [...completedIndexes].sort((a, b) => a - b),
          ...partial,
        }
        opts.onDeepResearchCheckpoint?.(checkpoint, completedIndexes.size, reusePlan.chunksToExtract.length)
      },
      onProgress: (_current, _total) => opts.onDeepResearchProgress?.(completedIndexes.size, reusePlan.chunksToExtract.length),
    })
    : resumableResult || { relations: [], mentions: [], chunkTags: [], chunkSummaries: [] }
  const chunkTags = [...reusePlan.chunkTags, ...extracted.chunkTags]
  const chunkSummaries = [...reusePlan.chunkSummaries, ...(extracted.chunkSummaries || [])]
  const summarizedIndexes = new Set(chunkSummaries.filter((item) => item.summary.trim()).map((item) => item.sourceChunkIndex))
  if (chunks.some((chunk) => !summarizedIndexes.has(chunk.chunkIndex))) {
    throw new Error('MEMORY_ANALYSIS_SUMMARY_MISSING')
  }
  opts.signal?.throwIfAborted()
  if (knowledge.getResetGeneration() !== resetGeneration) {
    throw new DOMException('Knowledge was reset during extraction', 'AbortError')
  }
  const knowledgeResult = knowledge.publishDocument({
    documentId: indexedDocument.document_id,
    contentHash,
    categoryId: opts.categoryId,
    fileName: opts.fileName,
    sourceId,
    chunks,
    relations: extracted.relations,
    mentions: extracted.mentions,
    chunkTags,
    chunkSummaries,
    reusableChunks: reusePlan.reusableChunks,
    extractorProviderId: opts.providerId || configuredTarget.providerId,
    extractorModel: opts.model || configuredTarget.model,
    validateBeforePublish: () => {
      const current = getDb().prepare(`
        SELECT content_hash FROM memory_file_index
        WHERE category_id = ? AND file_name = ?
      `).get(opts.categoryId, opts.fileName) as { content_hash: string } | undefined
      return current?.content_hash === contentHash
    },
  })
  await knowledge.indexSearchProjection(knowledgeResult.runId, opts.signal)
  opts.signal?.throwIfAborted()
  if (knowledge.getResetGeneration() !== resetGeneration) {
    throw new DOMException('Knowledge was reset during extraction', 'AbortError')
  }
  const tags = mergeDeepResearchChunkTags(chunkTags)
  const extractedTagsByChunk = new Map(chunkTags.map((item) => [item.sourceChunkIndex, item.tags]))
  const extractedSummariesByChunk = new Map(chunkSummaries.map((item) => [item.sourceChunkIndex, item.summary]))
  const factRows = getDb().prepare(`
    SELECT tu.chunk_index, se.canonical_name AS subject_name, p.canonical_name AS predicate_name,
      oe.canonical_name AS object_name, a.object_value_json, ev.note
    FROM memory_knowledge_assertion_evidence ev
    JOIN memory_knowledge_text_units tu ON tu.id = ev.text_unit_id
    JOIN memory_knowledge_assertions a ON a.id = ev.assertion_id
    JOIN memory_knowledge_predicates p ON p.id = a.predicate_id
    JOIN memory_knowledge_entities se ON se.id = a.subject_entity_id
    LEFT JOIN memory_knowledge_entities oe ON oe.id = a.object_entity_id
    WHERE ev.run_id = ? AND ev.quote_verified = 1 AND a.status IN ('active', 'disputed')
    ORDER BY tu.chunk_index, a.importance DESC
  `).all(knowledgeResult.runId) as Array<{
    chunk_index: number; subject_name: string; predicate_name: string; object_name: string | null; object_value_json: string | null; note: string
  }>
  const factsByChunk = new Map<number, string[]>()
  for (const fact of factRows) {
    let object = fact.object_name || ''
    if (!object && fact.object_value_json) {
      try { object = String(JSON.parse(fact.object_value_json)) } catch { object = fact.object_value_json }
    }
    const statement = [fact.subject_name, fact.predicate_name.replace(/_/g, ' '), object].filter(Boolean).join(' ')
    const searchableFact = fact.note?.trim() ? `${statement}. ${fact.note.trim()}` : statement
    if (!searchableFact) continue
    const current = factsByChunk.get(fact.chunk_index) || []
    current.push(searchableFact)
    factsByChunk.set(fact.chunk_index, current)
  }
  const chunkSearchKeywords = new Map(chunks.map((chunk) => [chunk.chunkIndex, {
    contentHash: chunk.contentHash,
    keywords: extractedTagsByChunk.get(chunk.chunkIndex) || [],
    summary: extractedSummariesByChunk.get(chunk.chunkIndex) || '',
    facts: factsByChunk.get(chunk.chunkIndex) || [],
  }]))
  const chunkFilter = andLanceDbFilters(
    lanceDbEqFilter('categoryId', opts.categoryId),
    lanceDbEqFilter('sourceFile', opts.fileName),
  )
  if (chunkFilter) {
    await getRAGStore().updateChunkSearchAnalysis(
      getActivePermanentMemoryTableName(),
      chunkFilter,
      chunkSearchKeywords,
      opts.signal,
    )
  }
  opts.signal?.throwIfAborted()
  const deepResearchedAt = Date.now()
  if (!markMemoryFileDeepResearched(opts.categoryId, opts.fileName, deepResearchedAt, contentHash, tags)) {
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
    deepResearchedAt,
    documentId: indexedDocument.document_id,
    contentHash,
    tags,
    chunksDeepResearched: reusePlan.chunksToExtract.length,
    chunksReused: reusePlan.reusableChunks.length,
  }
}

export async function deepResearchMemoryFile(opts: {
  directoryPath: string
  categoryId: string
  fileName: string
  replaceExisting?: boolean
  providerId?: string
  model?: string
  signal?: AbortSignal
  onDeepResearchProgress?: (current: number, total: number) => void
  resumeCheckpoint?: DeepResearchCheckpoint
  onDeepResearchCheckpoint?: (checkpoint: DeepResearchCheckpoint, current: number, total: number) => void
  affectedRanges?: MemorySourceRange[]
}): Promise<DeepResearchResult> {
  const content = await readMemoryFileForDeepResearch(opts.directoryPath, opts.fileName)
  return deepResearchMemoryContent({ ...opts, content })
}
