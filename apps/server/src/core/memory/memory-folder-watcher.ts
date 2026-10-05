/**
 * Chokidar-based filesystem watchers for memory folders.
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

const activeWatchers = new Map<string, FSWatcher>()
const MOVE_GRACE_MS = 2_000

interface PendingDelete {
    timer: ReturnType<typeof setTimeout>
    folderId: string
    fileName: string
}

const pendingDeletes = new Map<string, PendingDelete>()

function isExpectedWatchError(err: unknown): boolean {
    const code = typeof err === 'object' && err !== null && 'code' in err
        ? (err as { code?: unknown }).code
        : undefined
    return code === 'EPERM' || code === 'ENOENT'
}

function pendingDeleteKey(folderId: string, fileName: string): string {
    return `${folderId}\0${fileName}`
}

async function deleteIndexedFile(folderId: string, fileName: string): Promise<void> {
    await getAgentMemory().deleteSourceFile(fileName, folderId)
}

function scheduleDelete(folderId: string, fileName: string): void {
    const key = pendingDeleteKey(folderId, fileName)
    const existing = pendingDeletes.get(key)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
        pendingDeletes.delete(key)
        deleteIndexedFile(folderId, fileName)
            .catch(err => console.warn(`[memory-watcher] cleanup failed for ${fileName} in space ${folderId}:`, err))
    }, MOVE_GRACE_MS)
    pendingDeletes.set(key, { timer, folderId, fileName })
}

function clearPendingDelete(folderId: string, fileName: string): void {
    const key = pendingDeleteKey(folderId, fileName)
    const existing = pendingDeletes.get(key)
    if (!existing) return
    clearTimeout(existing.timer)
    pendingDeletes.delete(key)
}

async function tryRemapAddedFile(folderId: string, directoryPath: string, fileName: string): Promise<void> {
    const result = await getAgentMemory().remapMovedFileByHash(folderId, fileName, directoryPath)
    if (!result.remapped || !result.fromSpaceId || !result.fromFileName) return
    clearPendingDelete(result.fromSpaceId, result.fromFileName)
    console.log(`[memory-watcher] remapped moved file ${result.fromSpaceId}/${result.fromFileName} -> ${folderId}/${fileName}`)
}

/**
 * Start (or restart) a chokidar watcher for a memory folder folder.
 * Safe to call multiple times — stops any existing watcher first.
 * The watcher handles both the startup offline-diff purge and realtime deletions.
 */
export function watchMemoryFolder(folderId: string, directoryPath: string): void {
    stopWatchingMemoryFolder(folderId)

    // Offline tools (e.g. memory:eval) open data-dir snapshots whose startup
    // diff would purge index entries; they must never react to the filesystem.
    if (process.env.CYNOSURE_DISABLE_MEMORY_WATCHERS === '1') return

    if (!existsSync(directoryPath)) {
        console.warn(`[memory-watcher] not watching missing folder for space ${folderId}: ${directoryPath}`)
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
        clearPendingDelete(folderId, fileName)
        if (!ready) return
        tryRemapAddedFile(folderId, directoryPath, fileName)
            .catch(err => console.warn(`[memory-watcher] remap failed for ${fileName} in space ${folderId}:`, err))
    })

    // After the initial scan: purge DB entries for files no longer on disk
    watcher.on('ready', () => {
        ready = true
        const mem = getAgentMemory()
        const indexed = mem.getFileIndex(folderId)
        const orphans = [...indexed.keys()].filter(name => !seenOnDisk.has(name))
        for (const name of orphans) {
            scheduleDelete(folderId, name)
        }
        for (const name of seenOnDisk) {
            if (indexed.has(name)) continue
            tryRemapAddedFile(folderId, directoryPath, name)
                .catch(err => console.warn(`[memory-watcher] startup remap failed for ${name} in space ${folderId}:`, err))
        }
        if (orphans.length > 0) {
            console.log(`[memory-watcher] scheduled cleanup for ${orphans.length} stale entries from space ${folderId}`)
        }
    })

    // Realtime: file deleted or renamed away → clean up its index
    watcher.on('unlink', (filePath) => {
        const fileName = basename(filePath)
        seenOnDisk.delete(fileName)
        scheduleDelete(folderId, fileName)
    })

    watcher.on('unlinkDir', (deletedPath) => {
        if (resolve(deletedPath) !== watchedRoot) return
        console.warn(`[memory-watcher] watched folder for space ${folderId} was removed: ${directoryPath}`)
        stopWatchingMemoryFolder(folderId)
    })

    watcher.on('error', (err) => {
        if (isExpectedWatchError(err) && !existsSync(directoryPath)) {
            console.warn(`[memory-watcher] stopped watching removed folder for space ${folderId}: ${directoryPath}`)
        } else {
            console.warn(`[memory-watcher] watcher error for space ${folderId}:`, err)
        }
        stopWatchingMemoryFolder(folderId)
    })

    activeWatchers.set(folderId, watcher)
}

/** Stop watching a specific space folder. */
export function stopWatchingMemoryFolder(folderId: string): void {
    const watcher = activeWatchers.get(folderId)
    if (!watcher) return
    watcher.close().catch(() => { /* ignore */ })
    activeWatchers.delete(folderId)
    for (const [key, pending] of pendingDeletes.entries()) {
        if (pending.folderId !== folderId) continue
        clearTimeout(pending.timer)
        pendingDeletes.delete(key)
    }
}

/** Stop all active watchers (called on server shutdown). */
export async function stopAllMemoryFolderWatchers(): Promise<void> {
    await Promise.all([...activeWatchers.values()].map(w => w.close().catch(() => { /* ignore */ })))
    activeWatchers.clear()
    for (const pending of pendingDeletes.values()) clearTimeout(pending.timer)
    pendingDeletes.clear()
}
