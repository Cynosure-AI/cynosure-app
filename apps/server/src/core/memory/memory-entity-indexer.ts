import { readFileSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { getDb } from '../../db/database.js'
import { isParseableDocument, parseDocument } from '../utils/document-parser.js'
import { getEntityGraphStore } from './entity-graph.js'
import { PLAIN_TEXT_EXTENSIONS, readTextFile } from './memory-file-manager.js'
import { getMemoryParser, type PreparedMemoryChunk } from './parser.js'

export interface MemoryEntityIndexResult {
  fileName: string
  sourceId: string
  insertedOrUpdated: number
  deleted: number
  entityIndexedAt: number
  documentId: string
  contentHash: string
}

export interface MemoryEntityExtractionConfig {
  providerId?: string
  model?: string
}

const ENTITY_EXTRACTION_SETTINGS_KEY = 'memoryEntityExtraction'
const ENTITY_EXTRACTION_WINDOW_CHARS = 8_000

/** Batch several canonical RAG chunks into one extraction request while
 * retaining exact chunk tags for claim provenance. This keeps large-document
 * indexing bounded without reverting to unrelated character slices. */
function buildEntityExtractionSegments(chunks: PreparedMemoryChunk[]) {
  const groups: PreparedMemoryChunk[][] = []
  let current: PreparedMemoryChunk[] = []
  let currentChars = 0
  for (const chunk of chunks) {
    const taggedLength = chunk.text.length + 80
    if (current.length > 0 && currentChars + taggedLength > ENTITY_EXTRACTION_WINDOW_CHARS) {
      groups.push(current)
      current = []
      currentChars = 0
    }
    current.push(chunk)
    currentChars += taggedLength
  }
  if (current.length > 0) groups.push(current)

  return groups.map((group) => ({
    chunkIndex: group.length === 1 ? group[0].chunkIndex : undefined,
    chunkIndexes: group.map((chunk) => chunk.chunkIndex),
    content: [
      `Document: ${group[0].documentTitle}`,
      ...group.map((chunk) => [
        `<evidence_chunk index="${chunk.chunkIndex}" section="${chunk.sectionPath.replace(/"/g, '&quot;')}">`,
        chunk.text,
        '</evidence_chunk>',
      ].join('\n')),
    ].join('\n'),
  }))
}

function normalizeEntityExtractionConfig(config: Partial<MemoryEntityExtractionConfig> | undefined): MemoryEntityExtractionConfig {
  return {
    providerId: config?.providerId?.trim() || undefined,
    model: config?.model?.trim() || undefined,
  }
}

export function getMemoryEntityExtractionConfig(): MemoryEntityExtractionConfig {
  try {
    const row = getDb()
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get(ENTITY_EXTRACTION_SETTINGS_KEY) as { value_json: string } | undefined
    if (!row) return {}
    return normalizeEntityExtractionConfig(JSON.parse(row.value_json) as Partial<MemoryEntityExtractionConfig>)
  } catch {
    return {}
  }
}

export function saveMemoryEntityExtractionConfig(config: Partial<MemoryEntityExtractionConfig>): MemoryEntityExtractionConfig {
  const normalized = normalizeEntityExtractionConfig(config)
  getDb()
    .prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)')
    .run(ENTITY_EXTRACTION_SETTINGS_KEY, JSON.stringify(normalized))
  return normalized
}

export function memoryGraphSourceId(spaceId: string, fileName: string): string {
  return `memory:${spaceId}:${fileName}`
}

export function legacyMemoryGraphSourceId(fileName: string): string {
  return `memory:${fileName}`
}

export function markMemoryFileEntityIndexed(
  spaceId: string,
  fileName: string,
  indexedAt = Date.now(),
  expectedContentHash?: string,
): boolean {
  const result = expectedContentHash
    ? getDb().prepare(`
        UPDATE memory_file_index SET entity_indexed_at = ?
        WHERE space_id = ? AND file_name = ? AND content_hash = ?
      `).run(indexedAt, spaceId, fileName, expectedContentHash)
    : getDb().prepare(`
        UPDATE memory_file_index SET entity_indexed_at = ?
        WHERE space_id = ? AND file_name = ?
      `).run(indexedAt, spaceId, fileName)
  return result.changes > 0
}

export function moveMemoryGraphSource(sourceSpaceId: string, sourceFileName: string, targetSpaceId: string, targetFileName: string): void {
  const oldSourceId = memoryGraphSourceId(sourceSpaceId, sourceFileName)
  const oldLegacySourceId = legacyMemoryGraphSourceId(sourceFileName)
  const newSourceId = memoryGraphSourceId(targetSpaceId, targetFileName)
  const db = getDb()
  db.transaction(() => {
    db.prepare('UPDATE entity_graph_edges SET source_id = ? WHERE source_id = ?').run(newSourceId, oldSourceId)
    db.prepare('UPDATE entity_graph_edges SET source_id = ? WHERE source_id = ?').run(newSourceId, oldLegacySourceId)
    const moveEvidence = (priorSourceId: string) => {
      const rows = db.prepare('SELECT * FROM entity_graph_edge_evidence WHERE source_id = ?').all(priorSourceId) as Record<string, unknown>[]
      for (const row of rows) {
        db.prepare(`
          INSERT INTO entity_graph_edge_evidence
            (id, edge_id, source_kind, source_id, source_document_id, source_content_hash, source_chunk_index,
             evidence, confidence, mention_count, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(edge_id, source_kind, source_id) DO UPDATE SET
            evidence = CASE WHEN excluded.evidence != '' THEN excluded.evidence ELSE entity_graph_edge_evidence.evidence END,
            confidence = MAX(entity_graph_edge_evidence.confidence, excluded.confidence),
            mention_count = entity_graph_edge_evidence.mention_count + excluded.mention_count,
            first_seen_at = MIN(entity_graph_edge_evidence.first_seen_at, excluded.first_seen_at),
            last_seen_at = MAX(entity_graph_edge_evidence.last_seen_at, excluded.last_seen_at)
        `).run(
          row.id, row.edge_id, row.source_kind, newSourceId,
          row.source_document_id || '', row.source_content_hash || '', row.source_chunk_index ?? null, row.evidence,
          row.confidence, row.mention_count, row.first_seen_at, row.last_seen_at,
        )
        db.prepare('DELETE FROM entity_graph_edge_evidence WHERE id = ? AND source_id = ?').run(row.id, priorSourceId)
      }
    }
    moveEvidence(oldSourceId)
    moveEvidence(oldLegacySourceId)
  })()
}

export function deleteMemoryGraphSource(spaceId: string, fileName: string): { edgesDeleted: number; orphanedNodeIds: string[] } {
  const graph = getEntityGraphStore()
  const result = graph.deleteEdgesBySourceId(memoryGraphSourceId(spaceId, fileName))
  const legacy = graph.deleteEdgesBySourceId(legacyMemoryGraphSourceId(fileName))
  return {
    edgesDeleted: result.edgesDeleted + legacy.edgesDeleted,
    orphanedNodeIds: Array.from(new Set([...result.orphanedNodeIds, ...legacy.orphanedNodeIds])),
  }
}

export async function readMemoryFileForEntityIndex(folderPath: string, fileName: string): Promise<string> {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
  if (PLAIN_TEXT_EXTENSIONS.has(ext)) {
    return readTextFile(folderPath, fileName)
  }
  if (isParseableDocument(fileName)) {
    return parseDocument(readFileSync(join(folderPath, fileName)), fileName)
  }
  throw new Error(`Unsupported file type: ${ext}`)
}

export async function indexMemoryContentIntoEntityGraph(opts: {
  content: string
  spaceId: string
  fileName: string
  replaceExisting?: boolean
  providerId?: string
  model?: string
  signal?: AbortSignal
}): Promise<MemoryEntityIndexResult> {
  const contentHash = createHash('sha256').update(opts.content).digest('hex')
  const indexedDocument = getDb().prepare(`
    SELECT document_id, content_hash
    FROM memory_file_index
    WHERE space_id = ? AND file_name = ?
  `).get(opts.spaceId, opts.fileName) as { document_id: string; content_hash: string } | undefined
  if (!indexedDocument || indexedDocument.content_hash !== contentHash) {
    throw new Error('MEMORY_DOCUMENT_NOT_CURRENTLY_INDEXED')
  }

  const sourceId = memoryGraphSourceId(opts.spaceId, opts.fileName)
  const legacySourceId = legacyMemoryGraphSourceId(opts.fileName)
  const graph = getEntityGraphStore()
  const configuredTarget = getMemoryEntityExtractionConfig()
  const chunks = await getMemoryParser().prepareChunks(opts.content, opts.fileName)
  if (chunks.length === 0) {
    if (opts.replaceExisting !== false) deleteMemoryGraphSource(opts.spaceId, opts.fileName)
    const entityIndexedAt = Date.now()
    markMemoryFileEntityIndexed(opts.spaceId, opts.fileName, entityIndexedAt, contentHash)
    return {
      fileName: opts.fileName,
      sourceId,
      insertedOrUpdated: 0,
      deleted: 0,
      entityIndexedAt,
      documentId: indexedDocument.document_id,
      contentHash,
    }
  }
  const result = await graph.extractFromContent({
    content: opts.content,
    segments: buildEntityExtractionSegments(chunks),
    sourceId,
    sourceKind: 'memory',
    sourceDocumentId: indexedDocument.document_id,
    sourceContentHash: contentHash,
    providerId: opts.providerId || configuredTarget.providerId,
    model: opts.model || configuredTarget.model,
    signal: opts.signal,
    systemPrompt: 'Extract durable named entities and explicit relationships from this saved memory document.',
    replaceSourceIds: opts.replaceExisting === false
      ? undefined
      : Array.from(new Set([sourceId, legacySourceId])),
    validateBeforePublish: () => {
      const current = getDb().prepare(`
        SELECT content_hash FROM memory_file_index
        WHERE space_id = ? AND file_name = ?
      `).get(opts.spaceId, opts.fileName) as { content_hash: string } | undefined
      return current?.content_hash === contentHash
    },
  })
  const entityIndexedAt = Date.now()
  if (!markMemoryFileEntityIndexed(opts.spaceId, opts.fileName, entityIndexedAt, contentHash)) {
    // A concurrent edit landed after extraction committed. Remove the now-stale
    // version only; never delete a newer extraction that may already exist.
    graph.deleteEdgesBySourceId(sourceId, contentHash)
    throw new Error('ENTITY_GRAPH_SOURCE_CHANGED')
  }
  return {
    fileName: opts.fileName,
    sourceId,
    insertedOrUpdated: result.insertedOrUpdated,
    deleted: result.deleted,
    entityIndexedAt,
    documentId: indexedDocument.document_id,
    contentHash,
  }
}

export async function indexMemoryFileIntoEntityGraph(opts: {
  folderPath: string
  spaceId: string
  fileName: string
  replaceExisting?: boolean
  providerId?: string
  model?: string
  signal?: AbortSignal
}): Promise<MemoryEntityIndexResult> {
  const content = await readMemoryFileForEntityIndex(opts.folderPath, opts.fileName)
  return indexMemoryContentIntoEntityGraph({ ...opts, content })
}
