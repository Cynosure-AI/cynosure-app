/**
 * Chokidar-based filesystem watchers for memory space folders.
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
import { deleteMemoryGraphSource } from './memory-entity-indexer.js'

const activeWatchers = new Map<string, FSWatcher>()
const MOVE_GRACE_MS = 2_000

interface PendingDelete {
    timer: ReturnType<typeof setTimeout>
    spaceId: string
    fileName: string
}

const pendingDeletes = new Map<string, PendingDelete>()

function isExpectedWatchError(err: unknown): boolean {
    const code = typeof err === 'object' && err !== null && 'code' in err
        ? (err as { code?: unknown }).code
        : undefined
    return code === 'EPERM' || code === 'ENOENT'
}

function pendingDeleteKey(spaceId: string, fileName: string): string {
    return `${spaceId}\0${fileName}`
}

async function deleteIndexedFile(spaceId: string, fileName: string): Promise<void> {
    await getAgentMemory().deleteSourceFile(fileName, spaceId)
    deleteMemoryGraphSource(spaceId, fileName)
}

function scheduleDelete(spaceId: string, fileName: string): void {
    const key = pendingDeleteKey(spaceId, fileName)
    const existing = pendingDeletes.get(key)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
        pendingDeletes.delete(key)
        deleteIndexedFile(spaceId, fileName)
            .catch(err => console.warn(`[memory-watcher] cleanup failed for ${fileName} in space ${spaceId}:`, err))
    }, MOVE_GRACE_MS)
    pendingDeletes.set(key, { timer, spaceId, fileName })
}

function clearPendingDelete(spaceId: string, fileName: string): void {
    const key = pendingDeleteKey(spaceId, fileName)
    const existing = pendingDeletes.get(key)
    if (!existing) return
    clearTimeout(existing.timer)
    pendingDeletes.delete(key)
}

async function tryRemapAddedFile(spaceId: string, folderPath: string, fileName: string): Promise<void> {
    const result = await getAgentMemory().remapMovedFileByHash(spaceId, fileName, folderPath)
    if (!result.remapped || !result.fromSpaceId || !result.fromFileName) return
    clearPendingDelete(result.fromSpaceId, result.fromFileName)
    console.log(`[memory-watcher] remapped moved file ${result.fromSpaceId}/${result.fromFileName} -> ${spaceId}/${fileName}`)
}

/**
 * Start (or restart) a chokidar watcher for a memory space folder.
 * Safe to call multiple times — stops any existing watcher first.
 * The watcher handles both the startup offline-diff purge and realtime deletions.
 */
export function watchMemorySpace(spaceId: string, folderPath: string): void {
    stopWatchingMemorySpace(spaceId)

    if (!existsSync(folderPath)) {
        console.warn(`[memory-watcher] not watching missing folder for space ${spaceId}: ${folderPath}`)
        return
    }

    const seenOnDisk = new Set<string>()
    const watchedRoot = resolve(folderPath)

    const watcher = chokidar.watch(folderPath, {
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
        clearPendingDelete(spaceId, fileName)
        if (!ready) return
        tryRemapAddedFile(spaceId, folderPath, fileName)
            .catch(err => console.warn(`[memory-watcher] remap failed for ${fileName} in space ${spaceId}:`, err))
    })

    // After the initial scan: purge DB entries for files no longer on disk
    watcher.on('ready', () => {
        ready = true
        const mem = getAgentMemory()
        const indexed = mem.getFileIndex(spaceId)
        const orphans = [...indexed.keys()].filter(name => !seenOnDisk.has(name))
        for (const name of orphans) {
            scheduleDelete(spaceId, name)
        }
        for (const name of seenOnDisk) {
            if (indexed.has(name)) continue
            tryRemapAddedFile(spaceId, folderPath, name)
                .catch(err => console.warn(`[memory-watcher] startup remap failed for ${name} in space ${spaceId}:`, err))
        }
        if (orphans.length > 0) {
            console.log(`[memory-watcher] scheduled cleanup for ${orphans.length} stale entries from space ${spaceId}`)
        }
    })

    // Realtime: file deleted or renamed away → clean up its index
    watcher.on('unlink', (filePath) => {
        const fileName = basename(filePath)
        seenOnDisk.delete(fileName)
        scheduleDelete(spaceId, fileName)
    })

    watcher.on('unlinkDir', (deletedPath) => {
        if (resolve(deletedPath) !== watchedRoot) return
        console.warn(`[memory-watcher] watched folder for space ${spaceId} was removed: ${folderPath}`)
        stopWatchingMemorySpace(spaceId)
    })

    watcher.on('error', (err) => {
        if (isExpectedWatchError(err) && !existsSync(folderPath)) {
            console.warn(`[memory-watcher] stopped watching removed folder for space ${spaceId}: ${folderPath}`)
        } else {
            console.warn(`[memory-watcher] watcher error for space ${spaceId}:`, err)
        }
        stopWatchingMemorySpace(spaceId)
    })

    activeWatchers.set(spaceId, watcher)
}

/** Stop watching a specific space folder. */
export function stopWatchingMemorySpace(spaceId: string): void {
    const watcher = activeWatchers.get(spaceId)
    if (!watcher) return
    watcher.close().catch(() => { /* ignore */ })
    activeWatchers.delete(spaceId)
    for (const [key, pending] of pendingDeletes.entries()) {
        if (pending.spaceId !== spaceId) continue
        clearTimeout(pending.timer)
        pendingDeletes.delete(key)
    }
}

/** Stop all active watchers (called on server shutdown). */
export async function stopAllMemorySpaceWatchers(): Promise<void> {
    await Promise.all([...activeWatchers.values()].map(w => w.close().catch(() => { /* ignore */ })))
    activeWatchers.clear()
    for (const pending of pendingDeletes.values()) clearTimeout(pending.timer)
    pendingDeletes.clear()
}
