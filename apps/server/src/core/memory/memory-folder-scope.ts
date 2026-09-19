import { getDb } from '../../db/database.js'
import type Database from 'better-sqlite3'
import { lanceDbInFilter } from './lancedb-filter.js'
import { listAllMemoryFolderRefs, folderPathForDirectory } from './memory-folder-directories.js'

export type MemoryFolderRef = { id: string; name: string; description?: string; folderPath?: string }

const UNCATEGORIZED_CATEGORY_ID = 'uncategorized'
const AUTO_EXCLUDED_MEMORY_FOLDER_NAMES = new Set(['archive', 'subconscious', 'secret', 'hidden'])

export function isAutoExcludedMemoryFolderPath(folderPath: string): boolean {
    return folderPath
        .split('/')
        .some((segment) => AUTO_EXCLUDED_MEMORY_FOLDER_NAMES.has(segment.toLowerCase()))
}

/**
 * Resolve the default memory folder.
 * Uses the folder marked as Uncategorized.
 */
export function getDefaultMemoryFolder(): MemoryFolderRef | undefined {
    try {
        const db = getDb()
        const byFlag = db
            .prepare('SELECT id, name, description FROM memory_folders WHERE is_uncategorized = 1 ORDER BY sort_order ASC, created_at ASC LIMIT 1')
            .get() as { id: string; name: string; description: string | null } | undefined
        if (byFlag) return {
            id: byFlag.id,
            name: byFlag.name,
            ...(byFlag.description?.trim() ? { description: byFlag.description.trim() } : {}),
        }

        const byId = db
            .prepare('SELECT id, name, description FROM memory_folders WHERE id = ?')
            .get(UNCATEGORIZED_CATEGORY_ID) as { id: string; name: string; description: string | null } | undefined
        return byId ? {
            id: byId.id,
            name: byId.name,
            ...(byId.description?.trim() ? { description: byId.description.trim() } : {}),
        } : undefined
    } catch {
        return undefined
    }
}

/**
 * Return explicitly assigned memory folders for an agent.
 * An agent with no assignments has an explicit empty memory scope.
 */
export function getAssignedMemoryFolders(agentId: string): MemoryFolderRef[] {
    try {
        const db = getDb()
        const rows = db
            .prepare(
                `SELECT ms.id, ms.name, ms.description, ms.directory_path, ms.is_uncategorized
         FROM agent_memory_folders ams
         JOIN memory_folders ms ON ms.id = ams.category_id
         WHERE ams.agent_id = ?`
            )
            .all(agentId) as { id: string; name: string; description: string; directory_path: string; is_uncategorized: number }[]

        const assigned = rows.map((row) => ({
            id: row.id,
            name: row.name,
            ...(row.description?.trim() ? { description: row.description.trim() } : {}),
            folderPath: row.is_uncategorized === 1 ? '' : folderPathForDirectory(row.directory_path),
        }))

        return expandMemoryFolderScope(assigned, db)
    } catch {
        return []
    }
}

/** Expand folder grants to every currently registered descendant. */
export function expandMemoryFolderScope(folders: MemoryFolderRef[], db: Database.Database = getDb()): MemoryFolderRef[] {
    if (folders.length === 0) return []
    try {
        const all = listAllMemoryFolderRefs(db)
        const paths = folders.map(item => item.folderPath ?? '')
        return all.filter(item => {
            const itemIsAutoExcluded = isAutoExcludedMemoryFolderPath(item.folderPath)
            return paths.some(path => {
                const withinScope = !path || item.folderPath === path || item.folderPath.startsWith(`${path}/`)
                if (!withinScope) return false
                // The root is the automatic/default selection. Special folders are
                // omitted from that default, but any explicit folder grant behaves
                // normally and includes all of its descendants.
                return Boolean(path) || !itemIsAutoExcluded
            })
        })
    } catch {
        return folders
    }
}

export function getAllMemoryFolders(): MemoryFolderRef[] {
    try {
        return listAllMemoryFolderRefs(getDb())
    } catch {
        return []
    }
}

export function getMemoryFolderDirectoryPath(folderId: string): string | undefined {
    try {
        const db = getDb()
        const row = db
            .prepare('SELECT directory_path FROM memory_folders WHERE id = ?')
            .get(folderId) as { directory_path: string } | undefined
        return row?.directory_path || undefined
    } catch {
        return undefined
    }
}

/**
 * Build a LanceDB where-clause filter for a set of folders.
 */
export function buildMemoryFolderFilter(folders: Array<{ id: string }>): string | undefined {
    return lanceDbInFilter('folderId', folders.map((folder) => folder.id))
}
