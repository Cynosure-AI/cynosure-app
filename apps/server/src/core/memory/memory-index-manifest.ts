import { getDb } from '../../db/database.js'

const ACTIVE_INDEX_SETTINGS_KEY = 'activePermanentMemoryIndex'
export const DEFAULT_PERMANENT_MEMORY_TABLE = 'permanent_memory'
const TABLE_NAME_PATTERN = /^permanent_memory(?:_v_[a-z0-9_]+)?$/

export function getActivePermanentMemoryTableName(): string {
  try {
    const row = getDb().prepare('SELECT value_json FROM settings WHERE key = ?')
      .get(ACTIVE_INDEX_SETTINGS_KEY) as { value_json: string } | undefined
    if (!row) return DEFAULT_PERMANENT_MEMORY_TABLE
    const parsed = JSON.parse(row.value_json) as { tableName?: unknown }
    return typeof parsed.tableName === 'string' && TABLE_NAME_PATTERN.test(parsed.tableName)
      ? parsed.tableName
      : DEFAULT_PERMANENT_MEMORY_TABLE
  } catch {
    return DEFAULT_PERMANENT_MEMORY_TABLE
  }
}

export function setActivePermanentMemoryTableName(tableName: string): void {
  if (!TABLE_NAME_PATTERN.test(tableName)) throw new Error('Invalid permanent-memory table name')
  getDb().prepare(`
    INSERT INTO settings (key, value_json) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
  `).run(ACTIVE_INDEX_SETTINGS_KEY, JSON.stringify({ tableName, activatedAt: Date.now() }))
}

/** Atomically activate an index and the embedding configuration that matches it. */
export function activatePermanentMemoryIndex(tableName: string, embeddingConfig: unknown): void {
  if (!TABLE_NAME_PATTERN.test(tableName)) throw new Error('Invalid permanent-memory table name')
  const db = getDb()
  db.transaction(() => {
    db.prepare(`
      INSERT INTO settings (key, value_json) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
    `).run(ACTIVE_INDEX_SETTINGS_KEY, JSON.stringify({ tableName, activatedAt: Date.now() }))
    db.prepare(`
      INSERT INTO settings (key, value_json) VALUES ('embedding', ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
    `).run(JSON.stringify(embeddingConfig))
  })()
}
