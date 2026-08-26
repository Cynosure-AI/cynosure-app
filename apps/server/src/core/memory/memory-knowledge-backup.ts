import type Database from 'better-sqlite3'
import { getDb } from '../../db/database.js'
import { getMemoryKnowledgeStore } from './memory-knowledge.js'

const KNOWLEDGE_TABLES = [
  'memory_knowledge_index_runs',
  'memory_knowledge_text_units',
  'memory_knowledge_entities',
  'memory_knowledge_entity_aliases',
  'memory_knowledge_entity_resolution_decisions',
  'memory_knowledge_entity_mentions',
  'memory_knowledge_predicates',
  'memory_knowledge_assertions',
  'memory_knowledge_assertion_evidence',
  'memory_knowledge_assertion_corrections',
] as const

type KnowledgeTable = typeof KNOWLEDGE_TABLES[number]

export interface MemoryKnowledgeBackup {
  version: 1
  tables: Record<KnowledgeTable, Record<string, unknown>[]>
}

export interface MemoryKnowledgeRestoreResult {
  restored: number
  projectionRuns: number
  projectionDocuments: number
  projectionError?: string
}

export function createMemoryKnowledgeBackup(db: Database.Database = getDb()): MemoryKnowledgeBackup {
  return db.transaction(() => {
    const tables = Object.fromEntries(KNOWLEDGE_TABLES.map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[],
    ])) as MemoryKnowledgeBackup['tables']
    return { version: 1 as const, tables }
  })()
}

export function memoryKnowledgeBackupCount(backup: MemoryKnowledgeBackup): number {
  return KNOWLEDGE_TABLES.reduce((total, table) => total + backup.tables[table].length, 0)
}

function restoreTableRows(
  db: Database.Database,
  table: KnowledgeTable,
  rows: Record<string, unknown>[],
): number {
  const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)
  const allowedColumns = new Set(columns)
  let restored = 0
  for (const row of rows) {
    const rowColumns = Object.keys(row).filter((column) => allowedColumns.has(column))
    if (!rowColumns.length) continue
    const placeholders = rowColumns.map(() => '?').join(', ')
    db.prepare(`INSERT OR REPLACE INTO ${table} (${rowColumns.join(', ')}) VALUES (${placeholders})`)
      .run(...rowColumns.map((column) => row[column]))
    restored++
  }
  return restored
}

export async function restoreMemoryKnowledgeBackup(
  backup: MemoryKnowledgeBackup,
  db: Database.Database = getDb(),
): Promise<MemoryKnowledgeRestoreResult> {
  if (backup.version !== 1 || !backup.tables || typeof backup.tables !== 'object') {
    throw new Error('Unsupported knowledge backup format')
  }
  for (const table of KNOWLEDGE_TABLES) {
    if (!Array.isArray(backup.tables[table])) throw new Error(`Knowledge backup is missing ${table}`)
  }

  const knowledge = getMemoryKnowledgeStore()
  await knowledge.reset()
  let restored = 0
  db.transaction(() => {
    // Predicate inverses and merged entities can point to rows that occur later
    // in the archive, so validate foreign keys when the full graph is present.
    db.exec('PRAGMA defer_foreign_keys = ON')
    db.prepare(`UPDATE memory_knowledge_predicates SET inverse_predicate_id = NULL`).run()
    db.prepare(`DELETE FROM memory_knowledge_predicates`).run()
    for (const table of KNOWLEDGE_TABLES) {
      restored += restoreTableRows(db, table, backup.tables[table])
    }
    db.prepare(`UPDATE memory_knowledge_index_runs SET search_projection_status = 'pending', search_projection_error = NULL`).run()
    db.prepare(`
      UPDATE memory_file_index
      SET knowledge_extracted_at = COALESCE((
        SELECT MAX(r.activated_at) FROM memory_knowledge_index_runs r
        WHERE r.document_id = memory_file_index.document_id
          AND r.content_hash = memory_file_index.content_hash
          AND r.status = 'active'
      ), 0)
    `).run()
  })()

  try {
    const projection = await knowledge.reindexAllActiveSearchProjections()
    return {
      restored,
      projectionRuns: projection.runs,
      projectionDocuments: projection.documents,
    }
  } catch (error) {
    return {
      restored,
      projectionRuns: 0,
      projectionDocuments: 0,
      projectionError: error instanceof Error ? error.message : String(error),
    }
  }
}
