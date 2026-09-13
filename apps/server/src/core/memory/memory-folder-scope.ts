import { getDb } from '../../db/database.js'
import type Database from 'better-sqlite3'
import { lanceDbInFilter } from './lancedb-filter.js'
import { listAllMemoryFolderRefs, categoryPathForDirectory } from './memory-folder-directories.js'

export type MemoryFolderRef = { id: string; name: string; categoryPath?: string }

const UNCATEGORIZED_CATEGORY_ID = 'uncategorized'

/**
 * Resolve the default memory folder.
 * Uses the category marked as Uncategorized.
 */
export function getDefaultMemoryFolder(): MemoryFolderRef | undefined {
    try {
        const db = getDb()
        const byFlag = db
            .prepare('SELECT id, name FROM memory_folders WHERE is_uncategorized = 1 ORDER BY sort_order ASC, created_at ASC LIMIT 1')
            .get() as MemoryFolderRef | undefined
        if (byFlag) return byFlag

        return db
            .prepare('SELECT id, name FROM memory_folders WHERE id = ?')
            .get(UNCATEGORIZED_CATEGORY_ID) as MemoryFolderRef | undefined
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
                `SELECT ms.id, ms.name, ms.directory_path, ms.is_uncategorized
         FROM agent_memory_folders ams
         JOIN memory_folders ms ON ms.id = ams.category_id
         WHERE ams.agent_id = ?`
            )
            .all(agentId) as { id: string; name: string; directory_path: string; is_uncategorized: number }[]

        const assigned = rows.map((row) => ({
            id: row.id,
            name: row.name,
            categoryPath: row.is_uncategorized === 1 ? '' : categoryPathForDirectory(row.directory_path),
        }))

        return expandMemoryFolderScope(assigned, db)
    } catch {
        return []
    }
}

/** Expand category grants to every currently registered descendant. */
export function expandMemoryFolderScope(categories: MemoryFolderRef[], db: Database.Database = getDb()): MemoryFolderRef[] {
    if (categories.length === 0) return []
    try {
        const all = listAllMemoryFolderRefs(db)
        const paths = categories.map(item => item.categoryPath ?? '')
        return all.filter(item => paths.some(path => !path || item.categoryPath === path || item.categoryPath.startsWith(`${path}/`)))
    } catch {
        return categories
    }
}

export function getAllMemoryFolders(): MemoryFolderRef[] {
    try {
        return listAllMemoryFolderRefs(getDb())
    } catch {
        return []
    }
}

export function getMemoryFolderDirectoryPath(categoryId: string): string | undefined {
    try {
        const db = getDb()
        const row = db
            .prepare('SELECT directory_path FROM memory_folders WHERE id = ?')
            .get(categoryId) as { directory_path: string } | undefined
        return row?.directory_path || undefined
    } catch {
        return undefined
    }
}

/**
 * Build a LanceDB where-clause filter for a set of categories.
 */
export function buildMemoryFolderFilter(categories: Array<{ id: string }>): string | undefined {
    return lanceDbInFilter('categoryId', categories.map((category) => category.id))
}
