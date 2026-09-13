import type Database from 'better-sqlite3'
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync, type Dirent } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { nanoid } from 'nanoid'
import { getMemoryFoldersRootDir } from '../data-dir.js'
import { lanceDbEqFilter } from './lancedb-filter.js'
import { getRAGStore } from './rag.js'
import { getActivePermanentMemoryTableName } from './memory-index-manifest.js'
import { stopWatchingMemoryFolder, watchMemoryFolder } from './memory-folder-watcher.js'

export const UNCATEGORIZED_MEMORY_FOLDER_ID = 'uncategorized'
const FOLDER_MODEL_MIGRATION_KEY = 'memory.folder_model_v1'
const AGENT_FOLDER_MIGRATION_KEY = 'memory.agent_folder_v2'
export const AGENT_MEMORY_FOLDER_NAME = '.agents'
const IGNORED_FOLDER_NAMES = new Set(['default', '.trash', '.revisions', 'revisions', '.cynosure'])

export interface MemoryFolderDirectoryRow {
    id: string
    name: string
    description: string
    directory_path: string
    sort_order: number
    is_uncategorized: number
    created_at: number
}

export interface MemoryFolderDirectoryData {
    id: string
    name: string
    categoryPath: string
    directoryPath: string
    depth: number
    parentCategoryPath: string | null
}

export function memoryRootDir(): string {
    return getMemoryFoldersRootDir()
}

export function ensureMemoryRoot(): string {
    const root = memoryRootDir()
    mkdirSync(root, { recursive: true })
    return root
}

function normalizeSlashes(value: string): string {
    return value.replace(/\\/g, '/').replace(/\/+/g, '/')
}

export function categoryPathForDirectory(directoryPath: string): string {
    const root = resolve(memoryRootDir())
    const rel = normalizeSlashes(relative(root, resolve(directoryPath)))
    return rel === '.' ? '' : rel
}

export function directoryPathForRelative(categoryPath: string): string {
    const safeRelativePath = validateRelativePath(categoryPath)
    return safeRelativePath ? join(memoryRootDir(), ...safeRelativePath.split('/')) : memoryRootDir()
}

export function parentCategoryPath(categoryPath: string): string | null {
    if (!categoryPath) return null
    const idx = categoryPath.lastIndexOf('/')
    return idx < 0 ? '' : categoryPath.slice(0, idx)
}

export function memoryFolderDirectoryData(row: MemoryFolderDirectoryRow): MemoryFolderDirectoryData {
    const categoryPath = row.is_uncategorized === 1 ? '' : categoryPathForDirectory(row.directory_path)
    const depth = categoryPath ? categoryPath.split('/').length : 0
    return {
        id: row.id,
        name: row.name,
        categoryPath,
        directoryPath: row.directory_path,
        depth,
        parentCategoryPath: parentCategoryPath(categoryPath),
    }
}

export function validateRelativePath(input: string): string {
    const value = normalizeSlashes(input.trim()).replace(/^\/+|\/+$/g, '')
    if (!value) return ''
    if (isAbsolute(input)) throw new Error('Folder path must be relative to the memory root.')
    const segments = value.split('/')
    for (const [index, segment] of segments.entries()) {
        if (!segment || segment === '.' || segment === '..') {
            throw new Error('Folder path cannot contain empty, current, or parent directory segments.')
        }
        const isAgentMemoryRoot = index === 0 && segment.toLowerCase() === AGENT_MEMORY_FOLDER_NAME
        if ((segment.startsWith('.') && !isAgentMemoryRoot) || IGNORED_FOLDER_NAMES.has(segment.toLowerCase())) {
            throw new Error(`Folder "${segment}" is reserved and cannot be used as a memory folder.`)
        }
    }
    return segments.join('/')
}

export function categoryPathFromName(name: string): string {
    const cleaned = name
        .trim()
        .replace(/[\\/]+/g, '-')
        .replace(/[<>:"|?*\x00-\x1f]/g, '')
        .replace(/\s+/g, ' ')
    return validateRelativePath(cleaned || 'Untitled')
}

export function makeChildCategoryPath(name: string, parentPath = ''): string {
    const parent = validateRelativePath(parentPath)
    const child = categoryPathFromName(name)
    return parent ? `${parent}/${child}` : child
}

export function isIgnoredMemoryFolderName(name: string, allowAgentMemoryRoot = false): boolean {
    if (allowAgentMemoryRoot && name.toLowerCase() === AGENT_MEMORY_FOLDER_NAME) return false
    return name.startsWith('.') || IGNORED_FOLDER_NAMES.has(name.toLowerCase())
}

function discoverRelativeFolders(root: string): string[] {
    const result: string[] = []

    function walk(current: string, baseRelative: string): void {
        let entries: Dirent[]
        try {
            entries = readdirSync(current, { withFileTypes: true })
        } catch {
            return
        }

        for (const entry of entries) {
            if (!entry.isDirectory() || isIgnoredMemoryFolderName(entry.name, baseRelative === '')) continue
            const rel = baseRelative ? `${baseRelative}/${entry.name}` : entry.name
            result.push(rel)
            walk(join(current, entry.name), rel)
        }
    }

    walk(root, '')
    return result.sort((a, b) => a.localeCompare(b))
}

function idForRelativePath(categoryPath: string): string {
    return `category:${categoryPath}`
}

function nameForRelativePath(categoryPath: string): string {
    return basename(categoryPath)
}

function markMigrationComplete(db: Database.Database, key: string): void {
    db.prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(key, JSON.stringify({ completedAt: Date.now() }))
}

function hasMigrationRun(db: Database.Database, key: string): boolean {
    const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined
    return Boolean(row)
}

export async function runCategoryModelCleanupOnce(db: Database.Database): Promise<void> {
    const root = ensureMemoryRoot()
    if (!hasMigrationRun(db, FOLDER_MODEL_MIGRATION_KEY)) {
        const legacyDefaultFolder = join(root, 'default')
        if (existsSync(legacyDefaultFolder)) {
            try {
                const entries = readdirSync(legacyDefaultFolder, { withFileTypes: true })
                for (const entry of entries) {
                    if (!entry.isFile()) continue
                    const source = join(legacyDefaultFolder, entry.name)
                    let target = join(root, entry.name)
                    if (existsSync(target)) {
                        const dotIdx = entry.name.lastIndexOf('.')
                        const base = dotIdx > 0 ? entry.name.slice(0, dotIdx) : entry.name
                        const ext = dotIdx > 0 ? entry.name.slice(dotIdx) : ''
                        let counter = 2
                        do {
                            target = join(root, `${base} (${counter})${ext}`)
                            counter++
                        } while (existsSync(target))
                    }
                    renameSync(source, target)
                }
                removeFolderIfEmpty(legacyDefaultFolder)
            } catch {
                /* keep legacy files in place if the move fails */
            }
        }

        db.transaction(() => {
            db.prepare('UPDATE memory_folders SET name = ?, description = ?, directory_path = ?, sort_order = ?, is_uncategorized = ? WHERE id = ?')
                .run('Uncategorized', 'Memories that do not yet have a category', memoryRootDir(), 0, 1, UNCATEGORIZED_MEMORY_FOLDER_ID)
            markMigrationComplete(db, FOLDER_MODEL_MIGRATION_KEY)
        })()
    }

    if (!hasMigrationRun(db, AGENT_FOLDER_MIGRATION_KEY)) {
        const legacyAgentFolder = join(root, 'agents')
        const agentFolder = join(root, AGENT_MEMORY_FOLDER_NAME)
        if (existsSync(legacyAgentFolder) && !existsSync(agentFolder)) {
            renameSync(legacyAgentFolder, agentFolder)
            const rows = db.prepare('SELECT id, directory_path FROM memory_folders').all() as Array<{ id: string; directory_path: string }>
            const legacyPrefix = `${legacyAgentFolder}${sep}`
            const updateFolder = db.prepare('UPDATE memory_folders SET directory_path = ? WHERE id = ?')
            const updatePaths = db.transaction(() => {
                for (const row of rows) {
                    if (row.directory_path === legacyAgentFolder) updateFolder.run(agentFolder, row.id)
                    else if (row.directory_path.startsWith(legacyPrefix)) {
                        updateFolder.run(`${agentFolder}${row.directory_path.slice(legacyAgentFolder.length)}`, row.id)
                    }
                }
            })
            updatePaths()
        }
        markMigrationComplete(db, AGENT_FOLDER_MIGRATION_KEY)
    }
}

export function syncMemoryFoldersFromFolders(db: Database.Database): MemoryFolderDirectoryRow[] {
    const root = ensureMemoryRoot()
    db.prepare('UPDATE memory_folders SET directory_path = ?, is_uncategorized = 1 WHERE id = ?').run(root, UNCATEGORIZED_MEMORY_FOLDER_ID)

    const discovered = discoverRelativeFolders(root)
    const existingRows = db.prepare('SELECT * FROM memory_folders').all() as MemoryFolderDirectoryRow[]
    const existingByRelative = new Map<string, MemoryFolderDirectoryRow>()
    for (const row of existingRows) {
        if (row.is_uncategorized !== 1 && (!row.directory_path || !existsSync(row.directory_path))) {
            stopWatchingMemoryFolder(row.id)
            db.prepare('DELETE FROM memory_file_index WHERE category_id = ?').run(row.id)
            db.prepare('DELETE FROM agent_memory_folders WHERE category_id = ?').run(row.id)
            db.prepare('DELETE FROM memory_folders WHERE id = ?').run(row.id)
            continue
        }
        existingByRelative.set(row.is_uncategorized === 1 ? '' : categoryPathForDirectory(row.directory_path), row)
    }

    const now = Date.now()
    const insert = db.prepare(`
        INSERT INTO memory_folders (id, name, description, directory_path, sort_order, is_uncategorized, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const categoryPath of discovered) {
        if (existingByRelative.has(categoryPath)) continue
        insert.run(idForRelativePath(categoryPath), nameForRelativePath(categoryPath), '', directoryPathForRelative(categoryPath), 0, 0, now)
    }

    const rows = db.prepare('SELECT * FROM memory_folders ORDER BY is_uncategorized DESC, sort_order ASC, directory_path ASC').all() as MemoryFolderDirectoryRow[]
    for (const row of rows) {
        if (!row.directory_path) continue
        watchMemoryFolder(row.id, row.directory_path)
    }
    return rows
}

export function listAllMemoryFolderRefs(db: Database.Database): { id: string; name: string; categoryPath: string }[] {
    syncMemoryFoldersFromFolders(db)
    const rows = db.prepare('SELECT id, name, directory_path, is_uncategorized FROM memory_folders ORDER BY is_uncategorized DESC, directory_path ASC').all() as {
        id: string
        name: string
        directory_path: string
        is_uncategorized: number
    }[]
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        categoryPath: row.is_uncategorized === 1 ? '' : categoryPathForDirectory(row.directory_path),
    }))
}

export function renameMemoryFolderDirectory(row: MemoryFolderDirectoryRow, nextRelativePath: string): MemoryFolderDirectoryRow {
    const categoryPath = validateRelativePath(nextRelativePath)
    if (!categoryPath) throw new Error('Uncategorized memory folder cannot be moved or renamed.')
    const nextFolderPath = directoryPathForRelative(categoryPath)
    if (existsSync(nextFolderPath)) throw new Error('A memory folder already exists at that path.')

    mkdirSync(dirname(nextFolderPath), { recursive: true })
    renameSync(row.directory_path, nextFolderPath)
    stopWatchingMemoryFolder(row.id)
    watchMemoryFolder(row.id, nextFolderPath)
    return { ...row, name: nameForRelativePath(categoryPath), directory_path: nextFolderPath }
}

export function archiveMemoryFolderDirectory(row: MemoryFolderDirectoryRow): string | undefined {
    if (row.is_uncategorized === 1) throw new Error('Uncategorized memory folder cannot be archived.')
    if (!existsSync(row.directory_path)) return undefined

    const categoryPath = categoryPathForDirectory(row.directory_path)
    const leaf = categoryPath.replace(/\//g, '__')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const trashRoot = join(memoryRootDir(), '.trash')
    mkdirSync(trashRoot, { recursive: true })
    const dest = join(trashRoot, `${leaf || row.id}-${stamp}`)
    renameSync(row.directory_path, dest)
    stopWatchingMemoryFolder(row.id)
    return dest
}

export function removeFolderIfEmpty(directoryPath: string): void {
    try {
        const root = resolve(memoryRootDir())
        const target = resolve(directoryPath)
        if (target === root || !target.startsWith(root + sep)) return
        rmdirSync(target)
    } catch {
        /* keep non-empty folders */
    }
}

/** Remove an empty category folder and any newly empty category ancestors. */
export function removeEmptyMemoryFolderFolders(directoryPath: string): void {
    const root = resolve(memoryRootDir())
    let target = resolve(directoryPath)
    while (target !== root && target.startsWith(root + sep)) {
        try {
            rmdirSync(target)
        } catch {
            break
        }
        target = dirname(target)
    }
}

export function newMemoryFolderId(): string {
    return `category:${nanoid()}`
}

/** Ensure every segment of a validated category path exists and is registered. */
export function ensureMemoryFolderPath(db: Database.Database, requestedPath: string): MemoryFolderDirectoryRow {
    const categoryPath = validateRelativePath(requestedPath)
    if (!categoryPath) {
        const root = db.prepare('SELECT * FROM memory_folders WHERE is_uncategorized = 1 LIMIT 1').get() as MemoryFolderDirectoryRow | undefined
        if (!root) throw new Error('Uncategorized memory folder is unavailable.')
        return root
    }
    const createdDirectories: string[] = []
    const createdRows: Array<{ id: string; directoryPath: string }> = []
    try {
        db.transaction(() => {
            let current = ''
            for (const segment of categoryPath.split('/')) {
                current = current ? `${current}/${segment}` : segment
                const directoryPath = directoryPathForRelative(current)
                if (db.prepare('SELECT 1 FROM memory_folders WHERE directory_path = ?').get(directoryPath)) continue
                if (existsSync(directoryPath) && !statSync(directoryPath).isDirectory()) {
                    throw new Error(`Category path collides with a file at "${current}".`)
                }
                if (!existsSync(directoryPath)) {
                    mkdirSync(directoryPath)
                    createdDirectories.push(directoryPath)
                }
                const id = newMemoryFolderId()
                db.prepare('INSERT INTO memory_folders(id, name, description, directory_path, sort_order, is_uncategorized, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)')
                    .run(id, segment, '', directoryPath, Date.now())
                createdRows.push({ id, directoryPath })
            }
        })()
    } catch (error) {
        for (const directoryPath of createdDirectories.reverse()) removeFolderIfEmpty(directoryPath)
        throw error
    }
    for (const row of createdRows) watchMemoryFolder(row.id, row.directoryPath)
    return db.prepare('SELECT * FROM memory_folders WHERE directory_path = ?').get(directoryPathForRelative(categoryPath)) as MemoryFolderDirectoryRow
}
