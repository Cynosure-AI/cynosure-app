import { getDb } from '../../db/database.js'
import type { PermissionMode } from '@shared/types'

const MODES: readonly PermissionMode[] = ['read-only', 'auto', 'full']

export function isPermissionMode(value: unknown): value is PermissionMode {
    return MODES.includes(value as PermissionMode)
}

/** A chat's tool permission mode. Runs without a saved chat use auto. */
export function getPermissionMode(conversationId: string | undefined): PermissionMode {
    if (!conversationId) return 'auto'
    const row = getDb()
        .prepare('SELECT permission_mode FROM conversations WHERE id = ?')
        .get(conversationId) as { permission_mode: string } | undefined
    return isPermissionMode(row?.permission_mode) ? row.permission_mode : 'auto'
}

export function setPermissionMode(conversationId: string, mode: PermissionMode): void {
    getDb().prepare('UPDATE conversations SET permission_mode = ? WHERE id = ?').run(mode, conversationId)
}
