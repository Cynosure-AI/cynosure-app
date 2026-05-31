import type Database from 'better-sqlite3'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, type Dirent } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { nanoid } from 'nanoid'
import { getMemorySpacesRootDir } from '../data-dir.js'
import { lanceDbEqFilter } from './lancedb-filter.js'
import { getRAGStore } from './rag.js'
import { stopWatchingMemorySpace, watchMemorySpace } from './memory-space-watcher.js'

export const DEFAULT_MEMORY_SPACE_ID = 'default'
const FOLDER_MODEL_MIGRATION_KEY = 'memory.folder_model_v1'
const IGNORED_FOLDER_NAMES = new Set(['default', '.trash', '.revisions', 'revisions', '.cynosure'])

export interface MemorySpaceFolderRow {
    id: string
    name: string
    description: string
    folder_path: string
    sort_order: number
    is_default: number
    created_at: number
}

export interface MemorySpaceFolderData {
    id: string
    name: string
    relativePath: string
    folderPath: string
    depth: number
    parentRelativePath: string | null
}

export function memoryRootDir(): string {
    return getMemorySpacesRootDir()
}

export function ensureMemoryRoot(): string {
    const root = memoryRootDir()
    mkdirSync(root, { recursive: true })
    return root
}

function normalizeSlashes(value: string): string {
    return value.replace(/\\/g, '/').replace(/\/+/g, '/')
}

export function relativePathForFolder(folderPath: string): string {
    const root = resolve(memoryRootDir())
    const rel = normalizeSlashes(relative(root, resolve(folderPath)))
    return rel === '.' ? '' : rel
}

export function folderPathForRelative(relativePath: string): string {
    const safeRelativePath = validateRelativePath(relativePath)
    return safeRelativePath ? join(memoryRootDir(), ...safeRelativePath.split('/')) : memoryRootDir()
}

export function parentRelativePath(relativePath: string): string | null {
    if (!relativePath) return null
    const idx = relativePath.lastIndexOf('/')
    return idx < 0 ? '' : relativePath.slice(0, idx)
}

export function memorySpaceFolderData(row: MemorySpaceFolderRow): MemorySpaceFolderData {
    const relativePath = row.is_default === 1 ? '' : relativePathForFolder(row.folder_path)
    const depth = relativePath ? relativePath.split('/').length : 0
    return {
        id: row.id,
        name: row.name,
        relativePath,
        folderPath: row.folder_path,
        depth,
        parentRelativePath: parentRelativePath(relativePath),
    }
}

export function validateRelativePath(input: string): string {
    const value = normalizeSlashes(input.trim()).replace(/^\/+|\/+$/g, '')
    if (!value) return ''
    if (isAbsolute(input)) throw new Error('Folder path must be relative to the memory root.')
    const segments = value.split('/')
    for (const segment of segments) {
        if (!segment || segment === '.' || segment === '..') {
            throw new Error('Folder path cannot contain empty, current, or parent directory segments.')
        }
        if (segment.startsWith('.') || IGNORED_FOLDER_NAMES.has(segment.toLowerCase())) {
            throw new Error(`Folder "${segment}" is reserved and cannot be used as a memory folder.`)
        }
    }
    return segments.join('/')
}

export function relativePathFromName(name: string): string {
    const cleaned = name
        .trim()
        .replace(/[\\/]+/g, '-')
        .replace(/[<>:"|?*\x00-\x1f]/g, '')
        .replace(/\s+/g, ' ')
    return validateRelativePath(cleaned || 'Untitled')
}

export function makeSubfolderRelativePath(name: string, parentPath = ''): string {
    const parent = validateRelativePath(parentPath)
    const child = relativePathFromName(name)
    return parent ? `${parent}/${child}` : child
}

export function isIgnoredMemoryFolderName(name: string): boolean {
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
            if (!entry.isDirectory() || isIgnoredMemoryFolderName(entry.name)) continue
            const rel = baseRelative ? `${baseRelative}/${entry.name}` : entry.name
            result.push(rel)
            walk(join(current, entry.name), rel)
        }
    }

    walk(root, '')
    return result.sort((a, b) => a.localeCompare(b))
}

function idForRelativePath(relativePath: string): string {
    return `folder:${relativePath}`
}

function nameForRelativePath(relativePath: string): string {
    return basename(relativePath)
}

function markMigrationComplete(db: Database.Database): void {
    db.prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(FOLDER_MODEL_MIGRATION_KEY, JSON.stringify({ completedAt: Date.now() }))
}

function hasMigrationRun(db: Database.Database): boolean {
    const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(FOLDER_MODEL_MIGRATION_KEY) as { value_json: string } | undefined
    return Boolean(row)
}

export async function runFolderModelCleanupOnce(db: Database.Database): Promise<void> {
    if (hasMigrationRun(db)) return

    const root = ensureMemoryRoot()
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

    const legacyRows = db.prepare('SELECT id FROM memory_spaces WHERE id != ?').all(DEFAULT_MEMORY_SPACE_ID) as { id: string }[]
    const rag = getRAGStore()
    for (const row of legacyRows) {
        await rag.deleteByFilter('permanent_memory', lanceDbEqFilter('spaceId', row.id)).catch(() => undefined)
        stopWatchingMemorySpace(row.id)
    }

    db.transaction(() => {
        db.prepare('DELETE FROM memory_file_index WHERE space_id != ?').run(DEFAULT_MEMORY_SPACE_ID)
        db.prepare('DELETE FROM agent_memory_spaces WHERE space_id != ?').run(DEFAULT_MEMORY_SPACE_ID)
        db.prepare('DELETE FROM memory_spaces WHERE id != ?').run(DEFAULT_MEMORY_SPACE_ID)
        db.prepare('UPDATE memory_spaces SET name = ?, description = ?, folder_path = ?, sort_order = ?, is_default = ? WHERE id = ?')
            .run('Default', 'Default memory folder for general knowledge and notes', memoryRootDir(), 0, 1, DEFAULT_MEMORY_SPACE_ID)
        markMigrationComplete(db)
    })()
}

export function syncMemorySpacesFromFolders(db: Database.Database): MemorySpaceFolderRow[] {
    const root = ensureMemoryRoot()
    db.prepare('UPDATE memory_spaces SET folder_path = ?, is_default = 1 WHERE id = ?').run(root, DEFAULT_MEMORY_SPACE_ID)

    const discovered = discoverRelativeFolders(root)
    const existingRows = db.prepare('SELECT * FROM memory_spaces').all() as MemorySpaceFolderRow[]
    const existingByRelative = new Map<string, MemorySpaceFolderRow>()
    for (const row of existingRows) {
        if (row.is_default !== 1 && (!row.folder_path || !existsSync(row.folder_path))) {
            stopWatchingMemorySpace(row.id)
            db.prepare('DELETE FROM memory_file_index WHERE space_id = ?').run(row.id)
            db.prepare('DELETE FROM agent_memory_spaces WHERE space_id = ?').run(row.id)
            db.prepare('DELETE FROM memory_spaces WHERE id = ?').run(row.id)
            continue
        }
        existingByRelative.set(row.is_default === 1 ? '' : relativePathForFolder(row.folder_path), row)
    }

    const now = Date.now()
    const insert = db.prepare(`
        INSERT INTO memory_spaces (id, name, description, folder_path, sort_order, is_default, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const relativePath of discovered) {
        if (existingByRelative.has(relativePath)) continue
        insert.run(idForRelativePath(relativePath), nameForRelativePath(relativePath), '', folderPathForRelative(relativePath), 0, 0, now)
    }

    const rows = db.prepare('SELECT * FROM memory_spaces ORDER BY is_default DESC, sort_order ASC, folder_path ASC').all() as MemorySpaceFolderRow[]
    for (const row of rows) {
        if (!row.folder_path) continue
        watchMemorySpace(row.id, row.folder_path)
    }
    return rows
}

export function listAllMemorySpaceRefs(db: Database.Database): { id: string; name: string; relativePath: string }[] {
    syncMemorySpacesFromFolders(db)
    const rows = db.prepare('SELECT id, name, folder_path, is_default FROM memory_spaces ORDER BY is_default DESC, folder_path ASC').all() as {
        id: string
        name: string
        folder_path: string
        is_default: number
    }[]
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        relativePath: row.is_default === 1 ? '' : relativePathForFolder(row.folder_path),
    }))
}

export function renameMemorySpaceFolder(row: MemorySpaceFolderRow, nextRelativePath: string): MemorySpaceFolderRow {
    const relativePath = validateRelativePath(nextRelativePath)
    if (!relativePath) throw new Error('Default memory folder cannot be moved or renamed.')
    const nextFolderPath = folderPathForRelative(relativePath)
    if (existsSync(nextFolderPath)) throw new Error('A memory folder already exists at that path.')

    mkdirSync(dirname(nextFolderPath), { recursive: true })
    renameSync(row.folder_path, nextFolderPath)
    stopWatchingMemorySpace(row.id)
    watchMemorySpace(row.id, nextFolderPath)
    return { ...row, name: nameForRelativePath(relativePath), folder_path: nextFolderPath }
}

export function archiveMemorySpaceFolder(row: MemorySpaceFolderRow): string | undefined {
    if (row.is_default === 1) throw new Error('Default memory folder cannot be archived.')
    if (!existsSync(row.folder_path)) return undefined

    const relativePath = relativePathForFolder(row.folder_path)
    const leaf = relativePath.replace(/\//g, '__')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const trashRoot = join(memoryRootDir(), '.trash')
    mkdirSync(trashRoot, { recursive: true })
    const dest = join(trashRoot, `${leaf || row.id}-${stamp}`)
    renameSync(row.folder_path, dest)
    stopWatchingMemorySpace(row.id)
    return dest
}

export function removeFolderIfEmpty(folderPath: string): void {
    try {
        const root = resolve(memoryRootDir())
        const target = resolve(folderPath)
        if (target === root || !target.startsWith(root + sep)) return
        rmSync(target, { recursive: false })
    } catch {
        /* keep non-empty folders */
    }
}

export function newMemorySpaceId(): string {
    return `folder:${nanoid()}`
}
