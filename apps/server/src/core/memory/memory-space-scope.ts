import { getDb } from '../../db/database.js'

export type MemorySpaceRef = { id: string; name: string }

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
 * Return explicitly assigned spaces for an agent, or the default space if none are assigned.
 */
export function getAssignedOrDefaultSpaces(agentId: string): MemorySpaceRef[] {
    try {
        const db = getDb()
        const assigned = db
            .prepare(
                `SELECT ms.id, ms.name
         FROM agent_memory_spaces ams
         JOIN memory_spaces ms ON ms.id = ams.space_id
         WHERE ams.agent_id = ?`
            )
            .all(agentId) as MemorySpaceRef[]

        if (assigned.length > 0) return assigned

        const defaultSpace = getDefaultMemorySpace()
        return defaultSpace ? [defaultSpace] : []
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
