import Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  AGENT_MEMORY_FOLDER_NAME,
  ensureMemoryCategoryPath,
  isIgnoredMemoryFolderName,
  syncMemoryCategoriesFromFolders,
  validateRelativePath,
} from './memory-category-directories.js'

describe('memory category directories', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cynosure-memory-categories-'))
    process.env.CYNOSURE_DATA_DIR = dataDir
  })

  afterEach(() => {
    delete process.env.CYNOSURE_DATA_DIR
    rmSync(dataDir, { recursive: true, force: true })
  })

  test('normalizes safe paths and rejects traversal and reserved directories', () => {
    expect(validateRelativePath(' People\\Veronica Flowers/Hobbies/ ')).toBe('People/Veronica Flowers/Hobbies')
    expect(validateRelativePath('.agents/research_assistant')).toBe('.agents/research_assistant')
    expect(isIgnoredMemoryFolderName(AGENT_MEMORY_FOLDER_NAME, true)).toBe(false)
    expect(() => validateRelativePath('../private')).toThrow()
    expect(() => validateRelativePath('shared/.private')).toThrow(/reserved/)
    expect(() => validateRelativePath('Default/Notes')).toThrow(/reserved/)
  })

  test('discovers directories and atomically creates nested categories', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE memory_categories (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        directory_path TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL DEFAULT 0,
        is_uncategorized INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE memory_file_index (category_id TEXT);
      CREATE TABLE agent_memory_categories (category_id TEXT);
    `)
    const memoryRoot = join(dataDir, 'data', 'memories')
    mkdirSync(join(memoryRoot, 'Topics', 'AI'), { recursive: true })
    db.prepare(`INSERT INTO memory_categories
      (id, name, description, directory_path, sort_order, is_uncategorized, created_at)
      VALUES ('uncategorized', 'Uncategorized', '', ?, 0, 1, ?)`)
      .run(memoryRoot, Date.now())

    const discovered = syncMemoryCategoriesFromFolders(db)
    expect(discovered.some(row => row.name === 'AI')).toBe(true)

    const created = ensureMemoryCategoryPath(db, 'People/Veronica Flowers/Hobbies')
    expect(created.name).toBe('Hobbies')
    expect(existsSync(join(memoryRoot, 'People', 'Veronica Flowers', 'Hobbies'))).toBe(true)

    mkdirSync(join(memoryRoot, 'Valid'))
    writeFileSync(join(memoryRoot, 'Valid', 'collision'), 'file')
    const before = Number(db.prepare('SELECT COUNT(*) FROM memory_categories').pluck().get())
    expect(() => ensureMemoryCategoryPath(db, 'Valid/collision/Child')).toThrow()
    expect(Number(db.prepare('SELECT COUNT(*) FROM memory_categories').pluck().get())).toBe(before)
    expect(existsSync(join(memoryRoot, 'Valid'))).toBe(true)
    db.close()
  })
})
