/**
 * Chokidar-based filesystem watchers for memory category folders.
 *
 * On startup, chokidar scans the folder and fires `add` for every file found.
 * When `ready` fires, we compare those files against the DB index and purge
 * any orphaned entries (files removed from disk while the server was offline).
 * After that, `unlink` events keep the index current in real time.
 */

import chokidar, { type FSWatcher } from 'chokidar'
import { existsSync } from 'fs'
import { basename, resolve } from 'path'
import { getAgentMemory } from './agent-memory.js'
import { deleteMemoryKnowledgeSource } from './memory-deep-research.js'

const activeWatchers = new Map<string, FSWatcher>()
const MOVE_GRACE_MS = 2_000

interface PendingDelete {
    timer: ReturnType<typeof setTimeout>
    categoryId: string
    fileName: string
}

const pendingDeletes = new Map<string, PendingDelete>()
const pendingChanges = new Map<string, ReturnType<typeof setTimeout>>()

function isExpectedWatchError(err: unknown): boolean {
    const code = typeof err === 'object' && err !== null && 'code' in err
        ? (err as { code?: unknown }).code
        : undefined
    return code === 'EPERM' || code === 'ENOENT'
}

function pendingDeleteKey(categoryId: string, fileName: string): string {
    return `${categoryId}\0${fileName}`
}

async function deleteIndexedFile(categoryId: string, fileName: string): Promise<void> {
    await getAgentMemory().deleteSourceFile(fileName, categoryId)
    deleteMemoryKnowledgeSource(categoryId, fileName)
}

function scheduleDelete(categoryId: string, fileName: string): void {
    const key = pendingDeleteKey(categoryId, fileName)
    const existing = pendingDeletes.get(key)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
        pendingDeletes.delete(key)
        deleteIndexedFile(categoryId, fileName)
            .catch(err => console.warn(`[memory-watcher] cleanup failed for ${fileName} in space ${categoryId}:`, err))
    }, MOVE_GRACE_MS)
    pendingDeletes.set(key, { timer, categoryId, fileName })
}

function clearPendingDelete(categoryId: string, fileName: string): void {
    const key = pendingDeleteKey(categoryId, fileName)
    const existing = pendingDeletes.get(key)
    if (!existing) return
    clearTimeout(existing.timer)
    pendingDeletes.delete(key)
}

async function tryRemapAddedFile(categoryId: string, directoryPath: string, fileName: string): Promise<void> {
    const result = await getAgentMemory().remapMovedFileByHash(categoryId, fileName, directoryPath)
    if (!result.remapped || !result.fromSpaceId || !result.fromFileName) return
    clearPendingDelete(result.fromSpaceId, result.fromFileName)
    console.log(`[memory-watcher] remapped moved file ${result.fromSpaceId}/${result.fromFileName} -> ${categoryId}/${fileName}`)
}

/**
 * Start (or restart) a chokidar watcher for a memory category folder.
 * Safe to call multiple times — stops any existing watcher first.
 * The watcher handles both the startup offline-diff purge and realtime deletions.
 */
export function watchMemoryCategory(categoryId: string, directoryPath: string): void {
    stopWatchingMemoryCategory(categoryId)

    if (!existsSync(directoryPath)) {
        console.warn(`[memory-watcher] not watching missing folder for space ${categoryId}: ${directoryPath}`)
        return
    }

    const seenOnDisk = new Set<string>()
    const watchedRoot = resolve(directoryPath)

    const watcher = chokidar.watch(directoryPath, {
        persistent: false,
        ignoreInitial: false,  // fire `add` for existing files so we can diff against DB
        ignorePermissionErrors: true,
        depth: 0,
    })

    // Collect every file present on disk during the initial scan
    let ready = false

    watcher.on('add', (filePath) => {
        const fileName = basename(filePath)
        seenOnDisk.add(fileName)
        clearPendingDelete(categoryId, fileName)
        if (!ready) return
        tryRemapAddedFile(categoryId, directoryPath, fileName)
            .catch(err => console.warn(`[memory-watcher] remap failed for ${fileName} in space ${categoryId}:`, err))
    })

    // After the initial scan: purge DB entries for files no longer on disk
    watcher.on('ready', () => {
        ready = true
        const mem = getAgentMemory()
        const indexed = mem.getFileIndex(categoryId)
        const orphans = [...indexed.keys()].filter(name => !seenOnDisk.has(name))
        for (const name of orphans) {
            scheduleDelete(categoryId, name)
        }
        for (const name of seenOnDisk) {
            if (indexed.has(name)) continue
            tryRemapAddedFile(categoryId, directoryPath, name)
                .catch(err => console.warn(`[memory-watcher] startup remap failed for ${name} in space ${categoryId}:`, err))
        }
        if (orphans.length > 0) {
            console.log(`[memory-watcher] scheduled cleanup for ${orphans.length} stale entries from space ${categoryId}`)
        }
    })

    // Realtime: file deleted or renamed away → clean up its index
    watcher.on('unlink', (filePath) => {
        const fileName = basename(filePath)
        seenOnDisk.delete(fileName)
        scheduleDelete(categoryId, fileName)
    })

    watcher.on('change', (filePath) => {
        if (!ready) return
        const fileName = basename(filePath)
        const key = pendingDeleteKey(categoryId, fileName)
        const existing = pendingChanges.get(key)
        if (existing) clearTimeout(existing)
        pendingChanges.set(key, setTimeout(() => {
            pendingChanges.delete(key)
            const memory = getAgentMemory()
            if (memory.checkFileStatus(categoryId, fileName, directoryPath) === 'current') return
            memory.reindexFile(directoryPath, fileName, categoryId, { revisionContext: { source: 'filesystem' } })
                .catch(err => console.warn(`[memory-watcher] reindex failed for ${fileName} in category ${categoryId}:`, err))
        }, 500))
    })

    watcher.on('unlinkDir', (deletedPath) => {
        if (resolve(deletedPath) !== watchedRoot) return
        console.warn(`[memory-watcher] watched folder for space ${categoryId} was removed: ${directoryPath}`)
        stopWatchingMemoryCategory(categoryId)
    })

    watcher.on('error', (err) => {
        if (isExpectedWatchError(err) && !existsSync(directoryPath)) {
            console.warn(`[memory-watcher] stopped watching removed folder for space ${categoryId}: ${directoryPath}`)
        } else {
            console.warn(`[memory-watcher] watcher error for space ${categoryId}:`, err)
        }
        stopWatchingMemoryCategory(categoryId)
    })

    activeWatchers.set(categoryId, watcher)
}

/** Stop watching a specific space folder. */
export function stopWatchingMemoryCategory(categoryId: string): void {
    const watcher = activeWatchers.get(categoryId)
    if (!watcher) return
    watcher.close().catch(() => { /* ignore */ })
    activeWatchers.delete(categoryId)
    for (const [key, pending] of pendingDeletes.entries()) {
        if (pending.categoryId !== categoryId) continue
        clearTimeout(pending.timer)
        pendingDeletes.delete(key)
    }
    for (const [key, timer] of pendingChanges.entries()) {
        if (!key.startsWith(`${categoryId}\0`)) continue
        clearTimeout(timer)
        pendingChanges.delete(key)
    }
}

/** Stop all active watchers (called on server shutdown). */
export async function stopAllMemoryCategoryWatchers(): Promise<void> {
    await Promise.all([...activeWatchers.values()].map(w => w.close().catch(() => { /* ignore */ })))
    activeWatchers.clear()
    for (const pending of pendingDeletes.values()) clearTimeout(pending.timer)
    pendingDeletes.clear()
    for (const timer of pendingChanges.values()) clearTimeout(timer)
    pendingChanges.clear()
}
