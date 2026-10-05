import Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  AGENT_MEMORY_FOLDER_NAME,
  ensureDefaultMemoryFolders,
  ensureMemoryFolderPath,
  isIgnoredMemoryFolderName,
  removeEmptyMemoryFolderFolders,
  syncMemoryFoldersFromFolders,
  validateRelativePath,
} from './memory-folder-directories.js'
import { expandMemoryFolderScope } from './memory-folder-scope.js'

describe('memory folder directories', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cynosure-memory-folders-'))
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

  test('discovers directories and atomically creates nested folders', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE memory_folders (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        directory_path TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL DEFAULT 0,
        is_uncategorized INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        auto_memory_excluded INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE memory_file_index (category_id TEXT);
      CREATE TABLE agent_memory_folders (category_id TEXT);
    `)
    const memoryRoot = join(dataDir, 'data', 'memories')
    mkdirSync(join(memoryRoot, 'Topics', 'AI'), { recursive: true })
    mkdirSync(join(memoryRoot, '.agents', 'research_assistant'), { recursive: true })
    mkdirSync(join(memoryRoot, 'Archive', 'Old'), { recursive: true })
    db.prepare(`INSERT INTO memory_folders
      (id, name, description, directory_path, sort_order, is_uncategorized, created_at)
      VALUES ('uncategorized', 'Uncategorized', '', ?, 0, 1, ?)`)
      .run(memoryRoot, Date.now())

    const discovered = syncMemoryFoldersFromFolders(db)
    expect(discovered.some(row => row.name === 'AI')).toBe(true)

    const created = ensureMemoryFolderPath(db, 'People/Veronica Flowers/Hobbies')
    expect(created.name).toBe('Hobbies')
    expect(existsSync(join(memoryRoot, 'People', 'Veronica Flowers', 'Hobbies'))).toBe(true)
    const people = db.prepare("SELECT id, name FROM memory_folders WHERE name = 'People'").get() as { id: string; name: string }
    const peopleScope = expandMemoryFolderScope([{ ...people, folderPath: 'People' }], db)
    expect(peopleScope.map(folder => folder.folderPath)).toEqual([
      'People',
      'People/Veronica Flowers',
      'People/Veronica Flowers/Hobbies',
    ])

    // A formerly special folder name is omitted from the automatic root selection
    // only after the persisted setting is enabled; names are no longer magic.
    const peopleSecret = ensureMemoryFolderPath(db, 'People/SeCrEt')
    const defaultBeforeOptOut = expandMemoryFolderScope([{ id: 'uncategorized', name: 'Uncategorized', folderPath: '' }], db)
    expect(defaultBeforeOptOut.some(folder => folder.folderPath === 'Archive')).toBe(true)
    expect(defaultBeforeOptOut.some(folder => folder.folderPath === 'People/SeCrEt')).toBe(true)
    db.prepare("UPDATE memory_folders SET auto_memory_excluded = 1 WHERE name IN ('Archive', 'Old', 'SeCrEt')").run()

    const defaultScope = expandMemoryFolderScope([{ id: 'uncategorized', name: 'Uncategorized', folderPath: '' }], db)
    expect(defaultScope).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id })]))
    expect(defaultScope.some(folder => folder.folderPath === 'Archive')).toBe(false)
    expect(defaultScope.some(folder => folder.folderPath === 'People/SeCrEt')).toBe(false)
    expect(defaultScope.some(folder => folder.folderPath === '.agents')).toBe(true)

    expect(expandMemoryFolderScope([{ ...people, folderPath: 'People' }], db))
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: peopleSecret.id })]))

    const archiveScope = expandMemoryFolderScope([
      { id: 'archive', name: 'Archive', folderPath: 'Archive' },
    ], db)
    expect(archiveScope.map(folder => folder.folderPath)).toEqual([
      'Archive',
      'Archive/Old',
    ])

    mkdirSync(join(memoryRoot, 'Valid'))
    writeFileSync(join(memoryRoot, 'Valid', 'collision'), 'file')
    const before = Number(db.prepare('SELECT COUNT(*) FROM memory_folders').pluck().get())
    expect(() => ensureMemoryFolderPath(db, 'Valid/collision/Child')).toThrow()
    expect(Number(db.prepare('SELECT COUNT(*) FROM memory_folders').pluck().get())).toBe(before)
    expect(existsSync(join(memoryRoot, 'Valid'))).toBe(true)
    db.close()
  })

  test('removes an empty folder branch without removing a non-empty ancestor', () => {
    const memoryRoot = join(dataDir, 'data', 'memories')
    const branch = join(memoryRoot, 'Projects', 'Finished', 'Notes')
    mkdirSync(branch, { recursive: true })
    writeFileSync(join(memoryRoot, 'Projects', 'keep.md'), 'keep')

    removeEmptyMemoryFolderFolders(branch)

    expect(existsSync(branch)).toBe(false)
    expect(existsSync(join(memoryRoot, 'Projects', 'Finished'))).toBe(false)
    expect(existsSync(join(memoryRoot, 'Projects'))).toBe(true)
  })

  test('seeds default starter folders only on first launch', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE memory_folders (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        directory_path TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL DEFAULT 0,
        is_uncategorized INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        auto_memory_excluded INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE memory_file_index (category_id TEXT);
      CREATE TABLE agent_memory_folders (category_id TEXT);
    `)
    const memoryRoot = join(dataDir, 'data', 'memories')
    mkdirSync(memoryRoot, { recursive: true })
    db.prepare(`INSERT INTO memory_folders
      (id, name, description, directory_path, sort_order, is_uncategorized, created_at)
      VALUES ('uncategorized', 'Uncategorized', '', ?, 0, 1, ?)`)
      .run(memoryRoot, Date.now())

    ensureDefaultMemoryFolders(db)

    const names = db.prepare('SELECT name FROM memory_folders WHERE is_uncategorized != 1 ORDER BY directory_path')
      .all() as { name: string }[]
    expect(names.map(row => row.name)).toEqual([
      'Hobbies', 'Notes', 'Ideas', 'People', 'Personal', 'Travel', 'Work',
    ])
    expect(existsSync(join(memoryRoot, 'Personal'))).toBe(true)
    expect(existsSync(join(memoryRoot, 'Travel'))).toBe(true)
    const personal = db.prepare("SELECT description FROM memory_folders WHERE name = 'Personal'").get() as { description: string }
    expect(personal.description).toContain('Identity')

    // Existing user folders prevent re-seeding.
    ensureMemoryFolderPath(db, 'Custom')
    ensureDefaultMemoryFolders(db)
    expect(db.prepare("SELECT COUNT(*) FROM memory_folders WHERE name = 'Custom'").pluck().get()).toBe(1)
    expect(db.prepare("SELECT COUNT(*) FROM memory_folders WHERE name = 'Hobbies'").pluck().get()).toBe(1)

    // An empty install with pre-existing directories on disk is also left alone.
    db.prepare('DELETE FROM memory_folders WHERE is_uncategorized != 1').run()
    rmSync(memoryRoot, { recursive: true, force: true })
    mkdirSync(join(memoryRoot, 'Existing'), { recursive: true })
    ensureDefaultMemoryFolders(db)
    expect(db.prepare("SELECT COUNT(*) FROM memory_folders WHERE name = 'Existing'").pluck().get()).toBe(0)
    expect(db.prepare("SELECT COUNT(*) FROM memory_folders WHERE name = 'Work'").pluck().get()).toBe(0)

    db.close()
  })
})
