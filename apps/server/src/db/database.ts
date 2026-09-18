import Database from 'better-sqlite3'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { getAppDataDir, getDefaultMemoryFolderDir } from '../core/data-dir.js'
import { applySchemaMigrations } from './migrations.js'

let db: Database.Database | null = null

function getDbPath(): string {
  const dbDir = join(getAppDataDir(), 'sqlite')
  mkdirSync(dbDir, { recursive: true })
  return join(dbDir, 'cynosure.db')
}

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(getDbPath())
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    applySchemaMigrations(db)
    ensureDefaultMemoryFolder(db)
    // All pending HITL are void after a server restart — the executor promises are gone.
    db.prepare('DELETE FROM pending_hitl').run()
    // Queued chat messages survive restarts, but never resume work unexpectedly.
    db.prepare("UPDATE queued_chat_messages SET status = 'paused'").run()
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
