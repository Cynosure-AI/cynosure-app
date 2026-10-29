/**
 * File attachments of conversations: persistence, listing, shared assets and
 * their session refs (att-N). The model reads attachment text as session
 * content; documents meant for retrieval belong in a memory folder.
 */
import type { Database } from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'fs'
import { basename, join, sep } from 'path'
import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { getAppDataDir } from '../data-dir.js'
import { getRAGStore } from '../memory/rag.js'
import type { FileAttachmentArtifact } from './file-artifacts.js'
import { hasAttachmentAssetReferences, releaseAttachmentAsset, retainAttachmentAsset } from './attachment-asset-references.js'

/** Vector table of the retired attachment search; dropped once its data is no longer used. */
const LEGACY_ATTACHMENT_INDEX_TABLE = 'conversation_attachments'

export async function dropLegacyAttachmentIndex(): Promise<void> {
    try {
        await getRAGStore().deleteTable(LEGACY_ATTACHMENT_INDEX_TABLE)
    } catch (error) {
        console.warn('[attachments] Could not drop the retired attachment index:', error instanceof Error ? error.message : error)
    }
}

export async function reuseConversationAttachment(
    targetConversationId: string,
    sourceAttachmentId: string,
): Promise<FileAttachmentArtifact | null> {
    void targetConversationId
    const row = getDb().prepare(`
        SELECT a.id, ma.name, a.original_path, a.text_path, a.size_bytes, a.text_bytes
        FROM message_attachments ma JOIN attachment_assets a ON a.id = ma.asset_id
        WHERE ma.id = ? AND ma.kind = 'file'
    `).get(sourceAttachmentId) as {
        id: string; name: string; original_path: string | null; text_path: string | null;
        size_bytes: number | null; text_bytes: number | null;
    } | undefined
    if (!row?.original_path || !row.text_path || !existsSync(row.original_path) || !existsSync(row.text_path)) return null
    return retainAttachmentAsset(getDb(), {
        id: nanoid(),
        assetId: row.id,
        name: row.name,
        originalPath: row.original_path,
        textPath: row.text_path,
        sizeBytes: row.size_bytes ?? 0,
        textBytes: row.text_bytes ?? 0,
    })
}

export async function collectOrphanedAttachmentAssets(assetIds?: string[]): Promise<number> {
    if (assetIds?.length === 0) return 0
    const db = getDb()
    const rows = db.prepare(`SELECT a.id, a.original_path, a.text_path FROM attachment_assets a
        WHERE NOT EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.asset_id = a.id)
        ${assetIds ? `AND a.id IN (${assetIds.map(() => '?').join(',')})` : ''}`
    ).all(...(assetIds ?? [])) as Array<{ id: string; original_path: string; text_path: string }>
    let collected = 0
    for (const row of rows) {
        if (hasAttachmentAssetReferences(db, row.id)) continue
        // Remove discovery before yielding, so a new upload cannot reuse a retiring asset.
        db.prepare('DELETE FROM attachment_assets WHERE id = ?').run(row.id)
        for (const path of [row.original_path, row.text_path]) try { if (existsSync(path)) rmSync(path) } catch { /* best effort */ }
        collected++
    }
    return collected
}

/** Move conversation-owned files into canonical storage before their owner is deleted. */
export function preserveReferencedAttachmentAssets(deletingConversationIds: string[]): void {
    if (!deletingConversationIds.length) return
    const db = getDb()
    const placeholders = deletingConversationIds.map(() => '?').join(',')
    const rows = db.prepare(`SELECT DISTINCT a.id, a.original_path, a.text_path FROM attachment_assets a
        JOIN message_attachments owner ON owner.asset_id = a.id AND owner.conversation_id IN (${placeholders})
        JOIN message_attachments keep ON keep.asset_id = a.id AND keep.conversation_id NOT IN (${placeholders})`
    ).all(...deletingConversationIds, ...deletingConversationIds) as Array<{ id: string; original_path: string; text_path: string }>
    const directory = join(getAppDataDir(), 'artifacts', 'attachment-assets')
    mkdirSync(directory, { recursive: true })
    for (const row of rows) {
        if (row.original_path.startsWith(`${directory}${sep}`) && row.text_path.startsWith(`${directory}${sep}`)) continue
        const originalPath = join(directory, `${row.id}-${basename(row.original_path)}`)
        const textPath = join(directory, `${row.id}-${basename(row.text_path)}`)
        if (row.original_path !== originalPath && existsSync(row.original_path)) copyFileSync(row.original_path, originalPath)
        if (row.text_path !== textPath && existsSync(row.text_path)) copyFileSync(row.text_path, textPath)
        db.prepare('UPDATE attachment_assets SET original_path = ?, text_path = ? WHERE id = ?').run(originalPath, textPath, row.id)
        db.prepare('UPDATE message_attachments SET original_path = ?, text_path = ? WHERE asset_id = ?').run(originalPath, textPath, row.id)
    }
}

export function persistMessageFileAttachments(
    db: Database,
    messageId: string,
    conversationId: string,
    attachments: FileAttachmentArtifact[],
    createdAt: number,
): void {
    if (!attachments.length) return
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO message_attachments (
            id, message_id, conversation_id, kind, name, original_path, text_path,
            size_bytes, text_bytes, chunk_count, metadata_json, created_at, asset_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const attachment of attachments) {
        const assetId = attachment.assetId || attachment.id
        db.prepare(`INSERT OR IGNORE INTO attachment_assets
            (id, name, original_path, text_path, size_bytes, text_bytes, chunk_count, metadata_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(assetId, attachment.name, attachment.originalPath, attachment.textPath, attachment.sizeBytes,
            attachment.textBytes, null, JSON.stringify({ ...attachment, assetId }), createdAt)
        stmt.run(
            attachment.id,
            messageId,
            conversationId,
            'file',
            attachment.name,
            attachment.originalPath,
            attachment.textPath,
            attachment.sizeBytes,
            attachment.textBytes,
            null,
            JSON.stringify(attachment),
            createdAt,
            assetId,
        )
        releaseAttachmentAsset(attachment)
    }
}

/**
 * Give each file attachment in the conversation a session ref (att-N) that
 * stays fixed: the same file attached twice keeps its ref, and refs are
 * never renumbered. Attachments saved before refs existed get one here.
 */
function ensureAttachmentSessionRefs(db: Database, conversationId: string): void {
    const rows = db.prepare(`
        SELECT ma.id, ma.asset_id, ma.metadata_json FROM message_attachments ma
        WHERE ma.conversation_id = ? AND ma.kind = 'file' ORDER BY ma.created_at ASC, ma.rowid ASC
    `).all(conversationId) as { id: string; asset_id: string; metadata_json: string | null }[]
    const parsed = rows.map((row) => ({ ...row, metadata: parseAttachmentMetadata(row.metadata_json) }))
    const byAsset = new Map<string, string>()
    let highest = 0
    for (const row of parsed) {
        const ref = row.metadata.sessionRef
        if (typeof ref !== 'string') continue
        if (!byAsset.has(row.asset_id)) byAsset.set(row.asset_id, ref)
        highest = Math.max(highest, Number(/^att-(\d+)$/.exec(ref)?.[1] ?? 0))
    }
    const update = db.prepare('UPDATE message_attachments SET metadata_json = ? WHERE id = ?')
    for (const row of parsed) {
        if (typeof row.metadata.sessionRef === 'string') continue
        let ref = byAsset.get(row.asset_id)
        if (!ref) byAsset.set(row.asset_id, ref = `att-${++highest}`)
        update.run(JSON.stringify({ ...row.metadata, sessionRef: ref }), row.id)
    }
}

/** Set session refs on attachments about to be saved, so their notices can name them. */
export function assignAttachmentSessionRefs(db: Database, conversationId: string, attachments: FileAttachmentArtifact[]): void {
    const existing = listConversationFileAttachments(db, conversationId)
    const byAsset = new Map(existing.map((attachment) => [attachment.assetId || attachment.id, attachment.sessionRef]))
    let highest = existing.reduce((max, attachment) => Math.max(max, Number(/^att-(\d+)$/.exec(attachment.sessionRef ?? '')?.[1] ?? 0)), 0)
    for (const attachment of attachments) {
        const assetId = attachment.assetId || attachment.id
        let ref = byAsset.get(assetId)
        if (!ref) byAsset.set(assetId, ref = `att-${++highest}`)
        attachment.sessionRef = ref
    }
}

function parseAttachmentMetadata(json: string | null): Record<string, unknown> {
    try {
        const value: unknown = json ? JSON.parse(json) : {}
        return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
    } catch {
        return {}
    }
}

export function listConversationFileAttachments(db: Database, conversationId: string): FileAttachmentArtifact[] {
    ensureAttachmentSessionRefs(db, conversationId)
    const rows = db.prepare(`
        SELECT ma.id, ma.asset_id, ma.name, ma.metadata_json, a.original_path, a.text_path, a.size_bytes, a.text_bytes
        FROM message_attachments ma JOIN attachment_assets a ON a.id = ma.asset_id
        WHERE ma.conversation_id = ? AND ma.kind = 'file' ORDER BY ma.created_at ASC
    `).all(conversationId) as {
        id: string
        asset_id: string
        name: string
        metadata_json: string | null
        original_path: string | null
        text_path: string | null
        size_bytes: number | null
        text_bytes: number | null
    }[]

    const unique = new Map<string, FileAttachmentArtifact>()
    for (const row of rows) {
        const attachment = rowToFileAttachment(row)
        if (attachment) unique.set(attachment.assetId || attachment.id, attachment)
    }
    return [...unique.values()]
}

export function listConversationFileAttachmentsByMessage(db: Database, conversationId: string): Map<string, FileAttachmentArtifact[]> {
    ensureAttachmentSessionRefs(db, conversationId)
    const rows = db.prepare(`
        SELECT ma.message_id, ma.id, ma.asset_id, ma.name, ma.metadata_json, a.original_path, a.text_path, a.size_bytes, a.text_bytes
        FROM message_attachments ma JOIN attachment_assets a ON a.id = ma.asset_id
        WHERE ma.conversation_id = ? AND ma.kind = 'file' ORDER BY ma.created_at ASC
    `).all(conversationId) as {
        message_id: string
        id: string
        asset_id: string
        name: string
        metadata_json: string | null
        original_path: string | null
        text_path: string | null
        size_bytes: number | null
        text_bytes: number | null
    }[]

    const byMessage = new Map<string, FileAttachmentArtifact[]>()
    for (const row of rows) {
        const attachment = rowToFileAttachment(row)
        if (!attachment) continue
        const existing = byMessage.get(row.message_id) || []
        existing.push(attachment)
        byMessage.set(row.message_id, existing)
    }
    return byMessage
}

function rowToFileAttachment(row: {
    id: string
    asset_id?: string
    name: string
    metadata_json?: string | null
    original_path: string | null
    text_path: string | null
    size_bytes: number | null
    text_bytes: number | null
}): FileAttachmentArtifact | null {
    if (!row.original_path || !row.text_path) return null
    const sessionRef = parseAttachmentMetadata(row.metadata_json ?? null).sessionRef
    return {
        ...(typeof sessionRef === 'string' ? { sessionRef } : {}),
        id: row.id,
        assetId: row.asset_id || row.id,
        name: row.name,
        originalPath: row.original_path,
        textPath: row.text_path,
        sizeBytes: row.size_bytes ?? 0,
        textBytes: row.text_bytes ?? 0,
    }
}
