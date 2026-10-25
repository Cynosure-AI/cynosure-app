import type { Database } from 'better-sqlite3'
import { existsSync } from 'fs'
import { basename } from 'path'
import type { ContentBlock } from '@shared/types'
import { extractFilePathFromFileUrl } from './image-artifacts.js'

export interface ExportableAttachment {
    id: string
    name: string
    kind: 'file' | 'image' | 'audio' | 'video'
    sourcePath: string
}

const MEDIA_BLOCK_TYPES = new Set(['image', 'audio', 'video'])

/** The id the model uses for a media block: its stored filename, which is unique per conversation. */
export function mediaAttachmentId(url: string): string | null {
    const filePath = extractFilePathFromFileUrl(url)
    return filePath ? basename(filePath) : null
}

/**
 * Everything in a conversation that can be copied out to disk: uploaded
 * documents plus image, audio and video blocks from either side of the chat.
 * Source paths stay server-side; the model refers to entries by id.
 */
export function listExportableAttachments(db: Database, conversationId: string): ExportableAttachment[] {
    const found = new Map<string, ExportableAttachment>()

    const files = db.prepare(`
        SELECT ma.id, ma.name, a.original_path
        FROM message_attachments ma JOIN attachment_assets a ON a.id = ma.asset_id
        WHERE ma.conversation_id = ? AND ma.kind = 'file' ORDER BY ma.created_at ASC
    `).all(conversationId) as { id: string; name: string; original_path: string | null }[]
    for (const row of files) {
        if (row.original_path && existsSync(row.original_path)) {
            found.set(row.id, { id: row.id, name: row.name, kind: 'file', sourcePath: row.original_path })
        }
    }

    const messages = db.prepare(`
        SELECT content_blocks_json FROM messages
        WHERE conversation_id = ? AND content_blocks_json IS NOT NULL ORDER BY created_at ASC
    `).all(conversationId) as { content_blocks_json: string }[]
    for (const row of messages) {
        let blocks: ContentBlock[]
        try { blocks = JSON.parse(row.content_blocks_json) as ContentBlock[] } catch { continue }
        if (!Array.isArray(blocks)) continue
        for (const block of blocks) {
            if (!MEDIA_BLOCK_TYPES.has(block.type) || !('url' in block) || typeof block.url !== 'string') continue
            const sourcePath = extractFilePathFromFileUrl(block.url)
            if (!sourcePath || !existsSync(sourcePath)) continue
            const id = basename(sourcePath)
            found.set(id, { id, name: id, kind: block.type as ExportableAttachment['kind'], sourcePath })
        }
    }

    return [...found.values()]
}

export function findExportableAttachment(attachments: ExportableAttachment[], idOrName: string): ExportableAttachment | undefined {
    const wanted = idOrName.trim()
    return attachments.find((item) => item.id === wanted) ?? attachments.find((item) => item.name === wanted)
}

export function formatExportableAttachments(attachments: ExportableAttachment[]): string {
    if (!attachments.length) return 'This conversation has no attachments to export.'
    return attachments.map((item) => `- ${item.name} (${item.kind}, attachmentId: ${item.id})`).join('\n')
}
