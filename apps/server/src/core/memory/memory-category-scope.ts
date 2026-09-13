import { getDb } from '../../db/database.js'
import { lanceDbInFilter } from './lancedb-filter.js'
import { listAllMemoryCategoryRefs, categoryPathForDirectory } from './memory-category-directories.js'

export type MemoryCategoryRef = { id: string; name: string; categoryPath?: string }

const UNCATEGORIZED_CATEGORY_ID = 'uncategorized'

/**
 * Resolve the default memory category.
 * Uses the category marked as Uncategorized.
 */
export function getDefaultMemoryCategory(): MemoryCategoryRef | undefined {
    try {
        const db = getDb()
        const byFlag = db
            .prepare('SELECT id, name FROM memory_categories WHERE is_uncategorized = 1 ORDER BY sort_order ASC, created_at ASC LIMIT 1')
            .get() as MemoryCategoryRef | undefined
        if (byFlag) return byFlag

        return db
            .prepare('SELECT id, name FROM memory_categories WHERE id = ?')
            .get(UNCATEGORIZED_CATEGORY_ID) as MemoryCategoryRef | undefined
    } catch {
        return undefined
    }
}

/**
 * Return explicitly assigned memory categories for an agent.
 * An agent with no assignments has an explicit empty memory scope.
 */
export function getAssignedMemoryCategories(agentId: string): MemoryCategoryRef[] {
    try {
        const db = getDb()
        const rows = db
            .prepare(
                `SELECT ms.id, ms.name, ms.directory_path, ms.is_uncategorized
         FROM agent_memory_categories ams
         JOIN memory_categories ms ON ms.id = ams.category_id
         WHERE ams.agent_id = ?`
            )
            .all(agentId) as { id: string; name: string; directory_path: string; is_uncategorized: number }[]

        const assigned = rows.map((row) => ({
            id: row.id,
            name: row.name,
            categoryPath: row.is_uncategorized === 1 ? '' : categoryPathForDirectory(row.directory_path),
        }))

        const all = listAllMemoryCategoryRefs(db)
        const paths = assigned.map(item => item.categoryPath ?? '')
        return all.filter(item => paths.some(path => !path || item.categoryPath === path || item.categoryPath.startsWith(`${path}/`)))
    } catch {
        return []
    }
}

export function getAllMemoryCategories(): MemoryCategoryRef[] {
    try {
        return listAllMemoryCategoryRefs(getDb())
    } catch {
        return []
    }
}

export function getMemoryCategoryDirectoryPath(categoryId: string): string | undefined {
    try {
        const db = getDb()
        const row = db
            .prepare('SELECT directory_path FROM memory_categories WHERE id = ?')
            .get(categoryId) as { directory_path: string } | undefined
        return row?.directory_path || undefined
    } catch {
        return undefined
    }
}

/**
 * Build a LanceDB where-clause filter for a set of categories.
 */
export function buildMemoryCategoryFilter(categories: Array<{ id: string }>): string | undefined {
    return lanceDbInFilter('categoryId', categories.map((category) => category.id))
}
