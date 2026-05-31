import { getDb } from '../../db/database.js'
import { listAllMemorySpaceRefs, relativePathForFolder } from './memory-space-folders.js'

export type MemorySpaceRef = { id: string; name: string; relativePath?: string }

const DEFAULT_SPACE_ID = 'default'

function sqlString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`
}

/**
 * Resolve the default memory space.
 * Prefers is_default=1 and falls back to legacy id='default'.
 */
export function getDefaultMemorySpace(): MemorySpaceRef | undefined {
    try {
        const db = getDb()
        const byFlag = db
            .prepare('SELECT id, name FROM memory_spaces WHERE is_default = 1 ORDER BY sort_order ASC, created_at ASC LIMIT 1')
            .get() as MemorySpaceRef | undefined
        if (byFlag) return byFlag

        return db
            .prepare('SELECT id, name FROM memory_spaces WHERE id = ?')
            .get(DEFAULT_SPACE_ID) as MemorySpaceRef | undefined
    } catch {
        return undefined
    }
}

/**
 * Return explicitly assigned spaces for an agent, or all memory folders if none are assigned.
 */
export function getAssignedOrDefaultSpaces(agentId: string): MemorySpaceRef[] {
    try {
        const db = getDb()
        const rows = db
            .prepare(
                `SELECT ms.id, ms.name, ms.folder_path, ms.is_default
         FROM agent_memory_spaces ams
         JOIN memory_spaces ms ON ms.id = ams.space_id
         WHERE ams.agent_id = ?`
            )
            .all(agentId) as { id: string; name: string; folder_path: string; is_default: number }[]

        const assigned = rows.map((row) => ({
            id: row.id,
            name: row.name,
            relativePath: row.is_default === 1 ? '' : relativePathForFolder(row.folder_path),
        }))

        if (assigned.length > 0) return assigned

        return listAllMemorySpaceRefs(db)
    } catch {
        return []
    }
}

export function getAllMemorySpaces(): MemorySpaceRef[] {
    try {
        return listAllMemorySpaceRefs(getDb())
    } catch {
        return []
    }
}

/**
 * Build a LanceDB where-clause filter for a set of spaces.
 */
export function buildMemorySpaceFilter(spaces: Array<{ id: string }>): string | undefined {
    if (spaces.length === 0) return undefined
    if (spaces.length === 1) return `spaceId = ${sqlString(spaces[0].id)}`

    const ids = spaces.map((s) => sqlString(s.id)).join(', ')
    return `spaceId IN (${ids})`
}
