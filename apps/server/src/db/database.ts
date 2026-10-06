import Database from 'better-sqlite3'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { getAppDataDir, getDefaultMemoryFolderDir } from '../core/data-dir.js'
import { applySchemaMigrations } from './migrations.js'

let db: Database.Database | null = null

export function getDbPath(): string {
  if (process.env.VITEST && !process.env.CYNOSURE_DATA_DIR) {
    throw new Error('Tests must set CYNOSURE_DATA_DIR; refusing to open the real database.')
  }
  const dbDir = join(getAppDataDir(), 'sqlite')
  mkdirSync(dbDir, { recursive: true })
  return join(dbDir, 'cynosure.db')
}

export function getDb(): Database.Database {
  if (!db) {
    const opened = new Database(getDbPath())
    try {
      opened.pragma('journal_mode = WAL')
      opened.pragma('foreign_keys = ON')
      applySchemaMigrations(opened)
      ensureDefaultMemoryFolder(opened)
      // All pending HITL are void after a server restart — the executor promises are gone.
      opened.prepare('DELETE FROM pending_hitl').run()
      // Queued chat messages survive restarts, but never resume work unexpectedly.
      opened.prepare("UPDATE queued_chat_messages SET status = 'paused'").run()
    } catch (error) {
      // Never hand out a handle whose schema was not brought up to date.
      opened.close()
      throw error
    }
    db = opened
  }
  return db
}

export function ensureDefaultMemoryFolder(database: Database.Database = getDb()): void {
  const uncategorizedFolderId = 'uncategorized'
  const defaultFolderPath = getDefaultMemoryFolderDir()
  mkdirSync(defaultFolderPath, { recursive: true })

  const uncategorizedFolderExists = database.prepare("SELECT id FROM memory_folders WHERE id = ?").get(uncategorizedFolderId)
  if (!uncategorizedFolderExists) {
    const now = Date.now()
    database.prepare("INSERT INTO memory_folders (id, name, description, directory_path, sort_order, is_uncategorized, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(uncategorizedFolderId, 'Uncategorized', 'Memories that do not yet have a folder', defaultFolderPath, 0, 1, now)
    return
  }

  database.prepare("UPDATE memory_folders SET name = ?, description = ?, directory_path = ?, is_uncategorized = 1 WHERE id = ?")
    .run('Uncategorized', 'Memories that do not yet have a folder', defaultFolderPath, uncategorizedFolderId)
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
