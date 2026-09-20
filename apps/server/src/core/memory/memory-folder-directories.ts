import type Database from 'better-sqlite3'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, type Dirent } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { nanoid } from 'nanoid'
import { getMemoryFoldersRootDir } from '../data-dir.js'
import { stopWatchingMemoryFolder, watchMemoryFolder } from './memory-folder-watcher.js'

export const UNCATEGORIZED_MEMORY_FOLDER_ID = 'uncategorized'
export const AGENT_MEMORY_FOLDER_NAME = '.agents'
const IGNORED_FOLDER_NAMES = new Set(['default', '.trash', '.revisions', 'revisions', '.cynosure'])

export interface MemoryFolderDirectoryRow {
    id: string
    name: string
    description: string
    directory_path: string
    sort_order: number
    is_uncategorized: number
    auto_memory_excluded: number
    created_at: number
}

export interface MemoryFolderDirectoryData {
    id: string
    name: string
    folderPath: string
    directoryPath: string
    depth: number
    parentFolderPath: string | null
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

export function folderPathForDirectory(directoryPath: string): string {
    const root = resolve(memoryRootDir())
    const rel = normalizeSlashes(relative(root, resolve(directoryPath)))
    return rel === '.' ? '' : rel
}

export function directoryPathForRelative(folderPath: string): string {
    const safeRelativePath = validateRelativePath(folderPath)
    return safeRelativePath ? join(memoryRootDir(), ...safeRelativePath.split('/')) : memoryRootDir()
}

export function parentFolderPath(folderPath: string): string | null {
    if (!folderPath) return null
    const idx = folderPath.lastIndexOf('/')
    return idx < 0 ? '' : folderPath.slice(0, idx)
}

export function memoryFolderDirectoryData(row: MemoryFolderDirectoryRow): MemoryFolderDirectoryData {
    const folderPath = row.is_uncategorized === 1 ? '' : folderPathForDirectory(row.directory_path)
    const depth = folderPath ? folderPath.split('/').length : 0
    return {
        id: row.id,
        name: row.name,
        folderPath,
        directoryPath: row.directory_path,
        depth,
        parentFolderPath: parentFolderPath(folderPath),
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

export function folderPathFromName(name: string): string {
    const cleaned = name
        .trim()
        .replace(/[\\/]+/g, '-')
        .replace(/[<>:"|?*\x00-\x1f]/g, '')
        .replace(/\s+/g, ' ')
    return validateRelativePath(cleaned || 'Untitled')
}

export function makeChildFolderPath(name: string, parentPath = ''): string {
    const parent = validateRelativePath(parentPath)
    const child = folderPathFromName(name)
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

function idForRelativePath(folderPath: string): string {
    return `folder:${folderPath}`
}

function nameForRelativePath(folderPath: string): string {
    return basename(folderPath)
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
        existingByRelative.set(row.is_uncategorized === 1 ? '' : folderPathForDirectory(row.directory_path), row)
    }

    const now = Date.now()
    const insert = db.prepare(`
        INSERT INTO memory_folders (id, name, description, directory_path, sort_order, is_uncategorized, auto_memory_excluded, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const folderPath of discovered) {
        if (existingByRelative.has(folderPath)) continue
        const parentPath = folderPath.includes('/') ? folderPath.slice(0, folderPath.lastIndexOf('/')) : ''
        const parent = db.prepare('SELECT auto_memory_excluded FROM memory_folders WHERE directory_path = ?')
            .get(directoryPathForRelative(parentPath)) as { auto_memory_excluded: number } | undefined
        insert.run(idForRelativePath(folderPath), nameForRelativePath(folderPath), '', directoryPathForRelative(folderPath), 0, 0, parent?.auto_memory_excluded ?? 0, now)
    }

    const rows = db.prepare('SELECT * FROM memory_folders ORDER BY is_uncategorized DESC, sort_order ASC, directory_path ASC').all() as MemoryFolderDirectoryRow[]
    for (const row of rows) {
        if (!row.directory_path) continue
        watchMemoryFolder(row.id, row.directory_path)
    }
    return rows
}

export function listAllMemoryFolderRefs(db: Database.Database): { id: string; name: string; description?: string; folderPath: string; autoMemoryExcluded: boolean }[] {
    syncMemoryFoldersFromFolders(db)
    const rows = db.prepare('SELECT id, name, description, directory_path, is_uncategorized, auto_memory_excluded FROM memory_folders ORDER BY is_uncategorized DESC, directory_path ASC').all() as {
        id: string
        name: string
        description: string
        directory_path: string
        is_uncategorized: number
        auto_memory_excluded: number
    }[]
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        ...(row.description?.trim() ? { description: row.description.trim() } : {}),
        folderPath: row.is_uncategorized === 1 ? '' : folderPathForDirectory(row.directory_path),
        autoMemoryExcluded: row.auto_memory_excluded === 1,
    }))
}

export function renameMemoryFolderDirectory(row: MemoryFolderDirectoryRow, nextRelativePath: string): MemoryFolderDirectoryRow {
    const folderPath = validateRelativePath(nextRelativePath)
    if (!folderPath) throw new Error('Uncategorized memory folder cannot be moved or renamed.')
    const nextFolderPath = directoryPathForRelative(folderPath)
    if (existsSync(nextFolderPath)) throw new Error('A memory folder already exists at that path.')

    mkdirSync(dirname(nextFolderPath), { recursive: true })
    renameSync(row.directory_path, nextFolderPath)
    stopWatchingMemoryFolder(row.id)
    watchMemoryFolder(row.id, nextFolderPath)
    return { ...row, name: nameForRelativePath(folderPath), directory_path: nextFolderPath }
}

export function archiveMemoryFolderDirectory(row: MemoryFolderDirectoryRow): string | undefined {
    if (row.is_uncategorized === 1) throw new Error('Uncategorized memory folder cannot be archived.')
    if (!existsSync(row.directory_path)) return undefined

    const folderPath = folderPathForDirectory(row.directory_path)
    const leaf = folderPath.replace(/\//g, '__')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const trashRoot = join(memoryRootDir(), '.trash')
    mkdirSync(trashRoot, { recursive: true })
    const dest = join(trashRoot, `${leaf || row.id}-${stamp}`)
    renameSync(row.directory_path, dest)
    stopWatchingMemoryFolder(row.id)
    return dest
}

/** Permanently clear folder and document archives after the user empties trash. */
export function emptyMemoryTrashDirectories(directoryPaths: string[]): void {
    const root = resolve(memoryRootDir())
    const targets = new Set([join(root, '.trash')])
    for (const directoryPath of directoryPaths) {
        const directory = resolve(directoryPath)
        if (directory === root || directory.startsWith(root + sep)) targets.add(join(directory, '.trash'))
    }
    for (const target of targets) {
        const resolvedTarget = resolve(target)
        if (resolvedTarget !== join(root, '.trash') && !resolvedTarget.startsWith(root + sep)) continue
        if (existsSync(resolvedTarget)) rmSync(resolvedTarget, { recursive: true, force: true })
    }
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

/** Remove an empty folder folder and any newly empty folder ancestors. */
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
    return `folder:${nanoid()}`
}

/** Ensure every segment of a validated folder path exists and is registered. */
export function ensureMemoryFolderPath(db: Database.Database, requestedPath: string): MemoryFolderDirectoryRow {
    const folderPath = validateRelativePath(requestedPath)
    if (!folderPath) {
        const root = db.prepare('SELECT * FROM memory_folders WHERE is_uncategorized = 1 LIMIT 1').get() as MemoryFolderDirectoryRow | undefined
        if (!root) throw new Error('Uncategorized memory folder is unavailable.')
        return root
    }
    const createdDirectories: string[] = []
    const createdRows: Array<{ id: string; directoryPath: string }> = []
    try {
        db.transaction(() => {
            let current = ''
            for (const segment of folderPath.split('/')) {
                current = current ? `${current}/${segment}` : segment
                const directoryPath = directoryPathForRelative(current)
                if (db.prepare('SELECT 1 FROM memory_folders WHERE directory_path = ?').get(directoryPath)) continue
                if (existsSync(directoryPath) && !statSync(directoryPath).isDirectory()) {
                    throw new Error(`Folder path collides with a file at "${current}".`)
                }
                if (!existsSync(directoryPath)) {
                    mkdirSync(directoryPath)
                    createdDirectories.push(directoryPath)
                }
                const id = newMemoryFolderId()
                const parent = db.prepare('SELECT auto_memory_excluded FROM memory_folders WHERE directory_path = ?')
                    .get(directoryPathForRelative(current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '')) as { auto_memory_excluded: number } | undefined
                db.prepare('INSERT INTO memory_folders(id, name, description, directory_path, sort_order, is_uncategorized, auto_memory_excluded, created_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?)')
                    .run(id, segment, '', directoryPath, parent?.auto_memory_excluded ?? 0, Date.now())
                createdRows.push({ id, directoryPath })
            }
        })()
    } catch (error) {
        for (const directoryPath of createdDirectories.reverse()) removeFolderIfEmpty(directoryPath)
        throw error
    }
    for (const row of createdRows) watchMemoryFolder(row.id, row.directoryPath)
    return db.prepare('SELECT * FROM memory_folders WHERE directory_path = ?').get(directoryPathForRelative(folderPath)) as MemoryFolderDirectoryRow
}

/** Starter folders created on first launch so new users have a sensible structure. */
const DEFAULT_MEMORY_FOLDER_PATHS = [
    'Personal',
    'People',
    'Work',
    'Hobbies',
    'Notes & Ideas',
    'Travel',
] as const

const DEFAULT_MEMORY_FOLDER_DESCRIPTIONS: Record<string, string> = {
    'Personal': 'Identity, values, health, goals — everything about you',
    'People': 'Contacts, friends, and family — who they are and what matters to them',
    'Work': 'Career, projects, and professional knowledge',
    'Hobbies': 'Interests, games, sports, and creative pursuits',
    'Notes & Ideas': 'Scratch thoughts, references, and things worth remembering',
    'Travel': 'Trips, places visited, and travel wishlist',
}

/**
 * Create the starter memory folders on first launch. Only runs when the memory
 * root contains no user folders yet, so existing installs and restored backups
 * are never re-seeded.
 */
export function ensureDefaultMemoryFolders(db: Database.Database): void {
    const root = ensureMemoryRoot()
    const hasUserFolders = db.prepare('SELECT 1 FROM memory_folders WHERE is_uncategorized != 1 LIMIT 1').get()
    if (hasUserFolders) return
    if (discoverRelativeFolders(root).length > 0) return

    for (const folderPath of DEFAULT_MEMORY_FOLDER_PATHS) {
        try {
            ensureMemoryFolderPath(db, folderPath)
            const row = db.prepare('SELECT * FROM memory_folders WHERE directory_path = ?')
                .get(directoryPathForRelative(folderPath)) as MemoryFolderDirectoryRow | undefined
            if (row) {
                db.prepare('UPDATE memory_folders SET description = ? WHERE id = ?')
                    .run(DEFAULT_MEMORY_FOLDER_DESCRIPTIONS[folderPath] ?? '', row.id)
            }
        } catch {
            // Never block startup over a starter folder (e.g. name collision with a file).
        }
    }
}
