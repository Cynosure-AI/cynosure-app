import { readFileSync } from 'fs'
import { join } from 'path'
import { getDb } from '../../db/database.js'
import { isParseableDocument, parseDocument } from '../utils/document-parser.js'
import { getEntityGraphStore } from './entity-graph.js'
import { PLAIN_TEXT_EXTENSIONS, readTextFile } from './memory-file-manager.js'

export interface MemoryEntityIndexResult {
  fileName: string
  sourceId: string
  insertedOrUpdated: number
  deleted: number
  entityIndexedAt: number
}

export interface MemoryEntityExtractionConfig {
  providerId?: string
  model?: string
}

const ENTITY_EXTRACTION_SETTINGS_KEY = 'memoryEntityExtraction'

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

export function markMemoryFileEntityIndexed(spaceId: string, fileName: string, indexedAt = Date.now()): void {
  getDb().prepare(`
    INSERT INTO memory_file_index (space_id, file_name, entity_indexed_at, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(space_id, file_name) DO UPDATE SET
      entity_indexed_at = excluded.entity_indexed_at
  `).run(spaceId, fileName, indexedAt, indexedAt)
}

export function moveMemoryGraphSource(sourceSpaceId: string, sourceFileName: string, targetSpaceId: string, targetFileName: string): void {
  const oldSourceId = memoryGraphSourceId(sourceSpaceId, sourceFileName)
  const oldLegacySourceId = legacyMemoryGraphSourceId(sourceFileName)
  const newSourceId = memoryGraphSourceId(targetSpaceId, targetFileName)
  const db = getDb()
  db.prepare('UPDATE entity_graph_edges SET source_id = ? WHERE source_id = ?').run(newSourceId, oldSourceId)
  db.prepare('UPDATE entity_graph_edges SET source_id = ? WHERE source_id = ?').run(newSourceId, oldLegacySourceId)
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
  const sourceId = memoryGraphSourceId(opts.spaceId, opts.fileName)
  const graph = getEntityGraphStore()
  const existingEdgeIds = graph.edgeIdsBySourceId(sourceId)
  const configuredTarget = getMemoryEntityExtractionConfig()
  const result = await graph.extractFromContent({
    content: opts.content,
    sourceId,
    sourceKind: 'memory',
    providerId: opts.providerId || configuredTarget.providerId,
    model: opts.model || configuredTarget.model,
    signal: opts.signal,
    systemPrompt: 'Extract durable named entities and explicit relationships from this saved memory document.',
  })
  if (opts.replaceExisting !== false && result.touchedEdgeIds.length > 0) {
    graph.deleteEdgesBySourceIdExcept(sourceId, result.touchedEdgeIds)
    const legacy = legacyMemoryGraphSourceId(opts.fileName)
    if (legacy !== sourceId) graph.deleteEdgesBySourceId(legacy)
  } else if (opts.replaceExisting !== false && existingEdgeIds.length === 0 && result.touchedEdgeIds.length === 0) {
    const legacy = legacyMemoryGraphSourceId(opts.fileName)
    if (legacy !== sourceId) graph.deleteEdgesBySourceId(legacy)
  }
  const entityIndexedAt = Date.now()
  markMemoryFileEntityIndexed(opts.spaceId, opts.fileName, entityIndexedAt)
  return {
    fileName: opts.fileName,
    sourceId,
    insertedOrUpdated: result.insertedOrUpdated,
    deleted: result.deleted,
    entityIndexedAt,
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
