/**
 * Chokidar-based filesystem watchers for memory space folders.
 *
 * On startup, chokidar scans the folder and fires `add` for every file found.
 * When `ready` fires, we compare those files against the DB index and purge
 * any orphaned entries (files removed from disk while the server was offline).
 * After that, `unlink` events keep the index current in real time.
 */

import chokidar, { type FSWatcher } from 'chokidar'
import { basename } from 'path'
import { getAgentMemory } from './agent-memory.js'

const activeWatchers = new Map<string, FSWatcher>()

/**
 * Start (or restart) a chokidar watcher for a memory space folder.
 * Safe to call multiple times — stops any existing watcher first.
 * The watcher handles both the startup offline-diff purge and realtime deletions.
 */
export function watchMemorySpace(spaceId: string, folderPath: string): void {
    stopWatchingMemorySpace(spaceId)

    const seenOnDisk = new Set<string>()

    const watcher = chokidar.watch(folderPath, {
        persistent: false,
        ignoreInitial: false,  // fire `add` for existing files so we can diff against DB
        depth: 0,
    })

    // Collect every file present on disk during the initial scan
    watcher.on('add', (filePath) => {
        seenOnDisk.add(basename(filePath))
    })

    // After the initial scan: purge DB entries for files no longer on disk
    watcher.on('ready', () => {
        const mem = getAgentMemory()
        const indexed = mem.getFileIndex(spaceId)
        const orphans = [...indexed.keys()].filter(name => !seenOnDisk.has(name))
        for (const name of orphans) {
            mem.deleteSourceFile(name, spaceId)
                .catch(err => console.warn(`[memory-watcher] startup purge failed for ${name} in space ${spaceId}:`, err))
        }
        if (orphans.length > 0) {
            console.log(`[memory-watcher] purged ${orphans.length} stale entries from space ${spaceId}`)
        }
    })

    // Realtime: file deleted or renamed away → clean up its index
    watcher.on('unlink', (filePath) => {
        const fileName = basename(filePath)
        seenOnDisk.delete(fileName)
        getAgentMemory()
            .deleteSourceFile(fileName, spaceId)
            .catch(err => console.warn(`[memory-watcher] cleanup failed for ${fileName} in space ${spaceId}:`, err))
    })

    watcher.on('error', (err) => {
        console.warn(`[memory-watcher] watcher error for space ${spaceId}:`, err)
        activeWatchers.delete(spaceId)
    })

    activeWatchers.set(spaceId, watcher)
}

/** Stop watching a specific space folder. */
export function stopWatchingMemorySpace(spaceId: string): void {
    const watcher = activeWatchers.get(spaceId)
    if (!watcher) return
    watcher.close().catch(() => { /* ignore */ })
    activeWatchers.delete(spaceId)
}

/** Stop all active watchers (called on server shutdown). */
export async function stopAllMemorySpaceWatchers(): Promise<void> {
    await Promise.all([...activeWatchers.values()].map(w => w.close().catch(() => { /* ignore */ })))
    activeWatchers.clear()
}
