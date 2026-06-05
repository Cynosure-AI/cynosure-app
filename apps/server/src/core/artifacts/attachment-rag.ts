import type { Database } from 'better-sqlite3'
import type { ToolDefinition } from '../gateway/providers/base.provider.js'
import { getMemoryParser, type RetrievedChunk } from '../memory/parser.js'
import { getRAGStore } from '../memory/rag.js'
import { andLanceDbFilters, lanceDbEqFilter, lanceDbInFilter } from '../memory/lancedb-filter.js'
import { readFileAttachmentText, type FileAttachmentArtifact } from './file-artifacts.js'
import { getDb } from '../../db/database.js'

const TABLE_NAME = 'conversation_attachments'

export function conversationAttachmentSpaceId(conversationId: string): string {
    return `conversation:${conversationId}`
}

export function buildAttachmentFilter(conversationId: string, attachmentIds?: string[]): string | undefined {
    const scope = lanceDbEqFilter('spaceId', conversationAttachmentSpaceId(conversationId))
    const ids = attachmentIds?.length ? lanceDbInFilter('sourceFile', attachmentIds) : undefined
    return andLanceDbFilters(scope, ids)
}

export async function indexConversationAttachment(
    conversationId: string,
    attachment: FileAttachmentArtifact,
): Promise<number> {
    const text = readFileAttachmentText(attachment)
    if (!text?.trim()) return 0

    try {
        return await getMemoryParser().ingest(TABLE_NAME, text, {
            source: 'conversation_attachment',
            sourceFile: attachment.id,
            spaceId: conversationAttachmentSpaceId(conversationId),
        })
    } catch (err) {
        console.warn('[attachment-rag] Failed to index attachment:', err instanceof Error ? err.message : err)
        return 0
    }
}

export async function searchConversationAttachments(
    conversationId: string,
    query: string,
    topK = 6,
    attachmentIds?: string[],
): Promise<RetrievedChunk[]> {
    const filter = buildAttachmentFilter(conversationId, attachmentIds)
    try {
        return await getMemoryParser().retrieve(TABLE_NAME, query, Math.max(1, Math.min(topK, 20)), filter)
    } catch (err) {
        console.warn('[attachment-rag] Attachment search failed:', err instanceof Error ? err.message : err)
        return []
    }
}

export async function getConversationAttachmentChunks(
    conversationId: string,
    attachmentId: string,
    minIndex: number,
    maxIndex: number,
): Promise<{ text: string; chunkIndex: number; sourceFile: string; spaceId?: string }[]> {
    const filter = buildAttachmentFilter(conversationId)
    return getRAGStore().getChunksByRange(TABLE_NAME, attachmentId, minIndex, maxIndex, filter)
}

export async function countConversationAttachmentChunks(conversationId: string, attachmentId: string): Promise<number> {
    return getRAGStore().countBySource(TABLE_NAME, attachmentId, buildAttachmentFilter(conversationId))
}

export async function deleteConversationAttachmentIndex(conversationId: string): Promise<void> {
    const filter = buildAttachmentFilter(conversationId)
    if (!filter) return
    await getRAGStore().deleteByFilter(TABLE_NAME, filter)
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
            size_bytes, text_bytes, chunk_count, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const attachment of attachments) {
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
            attachment.chunkCount ?? null,
            JSON.stringify(attachment),
            createdAt,
        )
    }
}

export function listConversationFileAttachments(db: Database, conversationId: string): FileAttachmentArtifact[] {
    const records = db.prepare(`
        SELECT id, name, original_path, text_path, size_bytes, text_bytes, chunk_count
        FROM message_attachments
        WHERE conversation_id = ? AND kind = 'file'
        ORDER BY created_at ASC
    `).all(conversationId) as {
        id: string
        name: string
        original_path: string | null
        text_path: string | null
        size_bytes: number | null
        text_bytes: number | null
        chunk_count: number | null
    }[]

    if (records.length) {
        return records
            .filter((row) => row.original_path && row.text_path)
            .map((row) => ({
                id: row.id,
                name: row.name,
                originalPath: row.original_path!,
                textPath: row.text_path!,
                sizeBytes: row.size_bytes ?? 0,
                textBytes: row.text_bytes ?? 0,
                chunkCount: row.chunk_count ?? undefined,
            }))
    }

    const rows = db.prepare(
        'SELECT file_attachments_json FROM messages WHERE conversation_id = ? AND file_attachments_json IS NOT NULL ORDER BY created_at ASC'
    ).all(conversationId) as { file_attachments_json: string }[]

    const attachments: FileAttachmentArtifact[] = []
    const seen = new Set<string>()
    for (const row of rows) {
        try {
            const parsed = JSON.parse(row.file_attachments_json)
            if (!Array.isArray(parsed)) continue
            for (const item of parsed) {
                if (
                    typeof item?.id !== 'string' ||
                    typeof item.name !== 'string' ||
                    typeof item.textPath !== 'string' ||
                    seen.has(item.id)
                ) continue
                seen.add(item.id)
                attachments.push(item as FileAttachmentArtifact)
            }
        } catch {
            // Ignore malformed attachment metadata.
        }
    }
    return attachments
}

function formatAttachmentList(attachments: FileAttachmentArtifact[]): string {
    if (!attachments.length) return 'No indexed file attachments are available in this conversation.'
    return attachments.map((attachment) => {
        const chunks = attachment.chunkCount ? `, ${attachment.chunkCount} chunk${attachment.chunkCount !== 1 ? 's' : ''}` : ''
        return `- ${attachment.name} (attachmentId: ${attachment.id}${chunks}, ${attachment.textBytes} text bytes)`
    }).join('\n')
}

async function enrichChunkCounts(conversationId: string, attachments: FileAttachmentArtifact[]): Promise<Map<string, number>> {
    const entries = await Promise.all(attachments.map(async (attachment) => [
        attachment.id,
        attachment.chunkCount || await countConversationAttachmentChunks(conversationId, attachment.id),
    ] as const))
    return new Map(entries)
}

function formatSearchResults(
    results: RetrievedChunk[],
    attachmentsById: Map<string, FileAttachmentArtifact>,
    chunkCounts: Map<string, number>,
): string {
    return results.map((result) => {
        const attachment = result.sourceFile ? attachmentsById.get(result.sourceFile) : undefined
        const label = attachment?.name || result.sourceFile || 'attachment'
        const total = result.sourceFile ? chunkCounts.get(result.sourceFile) : undefined
        const part = result.chunkIndex != null && total
            ? ` · Part ${result.chunkIndex + 1}/${total}`
            : ''
        const id = result.sourceFile ? ` · attachmentId: ${result.sourceFile}` : ''
        const score = ` · score: ${(result.score * 100).toFixed(1)}%`
        return `[${label}${part}${id}${score}]\n${result.text}`
    }).join('\n\n---\n\n')
}

function resolveAttachmentIds(attachments: FileAttachmentArtifact[], fileName?: string): string[] | undefined {
    const wanted = fileName?.trim()
    if (!wanted) return undefined
    const lower = wanted.toLowerCase()
    const matches = attachments
        .filter((attachment) => attachment.id === wanted || attachment.name.toLowerCase() === lower)
        .map((attachment) => attachment.id)
    return matches.length ? matches : []
}

export function makeAttachmentTools(conversationId: string): ToolDefinition[] {
    return [
        {
            name: 'attachment_list_documents',
            description: 'List the indexed file/document attachments available in the current conversation.',
            parameters: { type: 'object', properties: {} },
            timeout: 10_000,
            execute: async () => {
                const attachments = listConversationFileAttachments(getDb(), conversationId)
                return { success: attachments.length > 0, output: formatAttachmentList(attachments) }
            },
        },
        {
            name: 'attachment_search',
            description: 'Search indexed file/document attachments in this conversation for information relevant to a query. Use this when the visible context does not contain enough detail from an attached document.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'A focused semantic search query.' },
                    topK: { type: 'number', description: 'Maximum chunks to return (default 5, max 10).' },
                    fileName: { type: 'string', description: 'Optional exact attachment name or attachmentId to restrict the search.' },
                },
                required: ['query'],
            },
            timeout: 20_000,
            execute: async (params: unknown) => {
                const { query, topK, fileName } = params as { query: string; topK?: number; fileName?: string }
                const attachments = listConversationFileAttachments(getDb(), conversationId)
                const ids = resolveAttachmentIds(attachments, fileName)
                if (ids?.length === 0) return { success: false, output: `No attachment matched "${fileName}".\n${formatAttachmentList(attachments)}` }

                const results = await searchConversationAttachments(conversationId, query, Math.min(topK ?? 5, 10), ids)
                if (!results.length) return { success: false, output: `No relevant attachment chunks found for "${query}".` }

                const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]))
                const chunkCounts = await enrichChunkCounts(conversationId, attachments)
                return { success: true, output: formatSearchResults(results, byId, chunkCounts) }
            },
        },
        {
            name: 'attachment_retrieve_chunks',
            description: 'Retrieve neighboring chunks from an indexed conversation attachment by attachmentId and zero-based chunk range. Use this to expand around a relevant search result or inspect a document section.',
            parameters: {
                type: 'object',
                properties: {
                    attachmentId: { type: 'string', description: 'The attachmentId shown by attachment_search or attachment_list_documents.' },
                    minIndex: { type: 'number', description: 'Minimum zero-based chunk index.' },
                    maxIndex: { type: 'number', description: 'Maximum zero-based chunk index, inclusive. Capped to 20 chunks per call.' },
                },
                required: ['attachmentId', 'minIndex', 'maxIndex'],
            },
            timeout: 20_000,
            execute: async (params: unknown) => {
                const { attachmentId, minIndex, maxIndex } = params as { attachmentId: string; minIndex: number; maxIndex: number }
                const attachments = listConversationFileAttachments(getDb(), conversationId)
                const attachment = attachments.find((item) => item.id === attachmentId)
                if (!attachment) return { success: false, output: `No attachment found with id "${attachmentId}".\n${formatAttachmentList(attachments)}` }

                const start = Math.max(0, Math.floor(minIndex))
                const end = Math.min(Math.max(start, Math.floor(maxIndex)), start + 19)
                const chunks = await getConversationAttachmentChunks(conversationId, attachmentId, start, end)
                if (!chunks.length) return { success: false, output: `No chunks found for "${attachment.name}" in range ${start}-${end}.` }

                const total = attachment.chunkCount || await countConversationAttachmentChunks(conversationId, attachmentId)
                const formatted = chunks.map((chunk) => `[${attachment.name} · Part ${chunk.chunkIndex + 1}/${total} · attachmentId: ${attachmentId}]\n${chunk.text}`).join('\n\n---\n\n')
                return { success: true, output: formatted }
            },
        },
    ]
}

export async function buildAttachmentContext(conversationId: string, query: string, db: Database): Promise<string | null> {
    const attachments = listConversationFileAttachments(db, conversationId)
    if (!attachments.length) return null

    const indexed = attachments.filter((attachment) => attachment.chunkCount && attachment.chunkCount > 0)
    if (!indexed.length) return null

    const chunkCounts = await enrichChunkCounts(conversationId, indexed)
    const byId = new Map(indexed.map((attachment) => [attachment.id, attachment]))
    const results = await searchConversationAttachments(conversationId, query, 6)

    const lines = [
        'Conversation file attachments are indexed for retrieval.',
        'Use attachment_search for focused lookups and attachment_retrieve_chunks to expand around relevant parts, especially for broad summaries or exact citations.',
        'Available attachments:',
        formatAttachmentList(indexed),
    ]

    if (results.length) {
        lines.push('', 'Relevant attachment excerpts for the current request:', formatSearchResults(results, byId, chunkCounts))
    }

    return lines.join('\n')
}
