import { getDb } from '../../db/database.js'
import { ATTACHMENT_TEXT_LIMITS } from '@cynosure/runtime-config'
import type Database from 'better-sqlite3'

const DEFAULT_INLINE_ATTACHMENT_TEXT_LIMIT = ATTACHMENT_TEXT_LIMITS.defaultInlineTextLimit
const MIN_INLINE_ATTACHMENT_TEXT_LIMIT = ATTACHMENT_TEXT_LIMITS.minInlineTextLimit
const MAX_INLINE_ATTACHMENT_TEXT_LIMIT = ATTACHMENT_TEXT_LIMITS.maxInlineTextLimit

export interface ChatAttachmentConfig {
    inlineAttachmentTextLimit: number
}

export function normalizeInlineAttachmentTextLimit(value: unknown): number {
    const numeric = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(numeric)) return DEFAULT_INLINE_ATTACHMENT_TEXT_LIMIT
    return Math.max(MIN_INLINE_ATTACHMENT_TEXT_LIMIT, Math.min(MAX_INLINE_ATTACHMENT_TEXT_LIMIT, Math.floor(numeric)))
}

export function getChatAttachmentConfig(db: Database.Database = getDb()): ChatAttachmentConfig {
    const row = db.prepare("SELECT value_json FROM settings WHERE key = 'chatAttachments'").get() as { value_json: string } | undefined
    if (!row) return { inlineAttachmentTextLimit: DEFAULT_INLINE_ATTACHMENT_TEXT_LIMIT }
    try {
        const parsed = JSON.parse(row.value_json) as { inlineAttachmentTextLimit?: unknown }
        return { inlineAttachmentTextLimit: normalizeInlineAttachmentTextLimit(parsed.inlineAttachmentTextLimit) }
    } catch {
        return { inlineAttachmentTextLimit: DEFAULT_INLINE_ATTACHMENT_TEXT_LIMIT }
    }
}

export function saveChatAttachmentConfig(
    input: { inlineAttachmentTextLimit: unknown },
    db: Database.Database = getDb(),
): ChatAttachmentConfig {
    const inlineAttachmentTextLimit = normalizeInlineAttachmentTextLimit(input.inlineAttachmentTextLimit)
    db.prepare(
        "INSERT OR REPLACE INTO settings (key, value_json) VALUES ('chatAttachments', ?)"
    ).run(JSON.stringify({ inlineAttachmentTextLimit }))
    return { inlineAttachmentTextLimit }
}
