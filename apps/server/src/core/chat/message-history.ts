import Database from 'better-sqlite3'
import { existsSync, readFileSync } from 'fs'
import { extname } from 'path'
import { COMPACT_EVENT_PREFIX } from '../agent/context-compactor.js'
import { extractFilePathFromFileUrl } from '../artifacts/image-artifacts.js'
import { listConversationFileAttachmentsByMessage } from '../artifacts/attachment-rag.js'
import { readFileAttachmentText, type FileAttachmentArtifact } from '../artifacts/file-artifacts.js'
import type { ChatMessage, ContentPart, ToolCall } from '../gateway/providers/base.provider.js'

export interface ChatHistoryRow {
    id: string
    role: string
    content: string
    tool_calls_json: string | null
    tool_call_id: string | null
    agent_id: string | null
    image_urls_json: string | null
    audio_urls_json: string | null
    created_at: number
}

export interface BuiltChatHistory {
    historyRows: ChatHistoryRow[]
    filteredRows: ChatHistoryRow[]
    messages: ChatMessage[]
}

export function buildRecentImageArtifactsSystemHint(rows: ChatHistoryRow[], limit = 5): string | null {
    const artifacts: { path: string; url: string }[] = []
    const seen = new Set<string>()

    for (let i = rows.length - 1; i >= 0 && artifacts.length < limit; i--) {
        const row = rows[i]
        if (row.role !== 'assistant' || !row.image_urls_json) continue
        try {
            const urls = JSON.parse(row.image_urls_json) as string[]
            for (let j = urls.length - 1; j >= 0 && artifacts.length < limit; j--) {
                const url = urls[j]
                const path = extractFilePathFromFileUrl(url)
                if (!path || seen.has(path)) continue
                seen.add(path)
                artifacts.push({ path, url })
            }
        } catch {
            // Ignore malformed image metadata.
        }
    }

    if (!artifacts.length) return null

    const lines = artifacts.map((artifact, index) => (
        `${index === 0 ? 'latest generated image' : `generated image ${index + 1}`}: path=${artifact.path}; url=${artifact.url}`
    ))

    return [
        'Recent generated image artifacts are available for follow-up file/tool operations.',
        'Use these absolute paths when the user refers to "the image", "that image", "the last generated image", or asks to save/upload/edit a generated image.',
        ...lines,
    ].join('\n')
}

export function appendHiddenSystemContext(messages: ChatMessage[], hint: string | null): ChatMessage[] {
    if (!hint) return messages
    let systemIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'system') {
            systemIndex = i
            break
        }
    }
    if (systemIndex === -1) {
        return [{ role: 'system', content: hint }, ...messages]
    }

    return messages.map((message, index) => {
        if (index !== systemIndex) return message
        const content = typeof message.content === 'string'
            ? message.content
            : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
        return {
            ...message,
            content: `${content}\n\n${hint}`
        }
    })
}

export function buildConversationHistory(input: {
    db: Database.Database
    conversationId: string
    mainAgentId: string | null
    inlineAttachmentTextLimit: number
}): BuiltChatHistory {
    const { db, conversationId, mainAgentId, inlineAttachmentTextLimit } = input
    const historyRows = db
        .prepare(
            'SELECT id, role, content, tool_calls_json, tool_call_id, agent_id, image_urls_json, audio_urls_json, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
        )
        .all(conversationId) as ChatHistoryRow[]
    const attachmentsByMessage = listConversationFileAttachmentsByMessage(db, conversationId)

    const keptToolCallIds = new Set<string>()
    const filteredRows = historyRows.filter((row) => {
        if (row.role === 'system' && row.content.startsWith(COMPACT_EVENT_PREFIX)) return false
        if (row.role === 'user') return true
        if (row.role === 'assistant') {
            const isMainAgent = row.agent_id === null || row.agent_id === mainAgentId
            if (isMainAgent) {
                if (row.tool_calls_json) {
                    try {
                        for (const toolCall of JSON.parse(row.tool_calls_json)) {
                            if (toolCall.id) keptToolCallIds.add(toolCall.id)
                        }
                    } catch {
                        // Ignore parse errors; the row can still be useful as assistant text.
                    }
                }
                return true
            }
            return false
        }
        if (row.role === 'tool') {
            return !row.tool_call_id || keptToolCallIds.has(row.tool_call_id)
        }
        return true
    })

    const messages = filteredRows.map((row) => ({
        role: row.role as ChatMessage['role'],
        content: buildHistoryContent(row, inlineAttachmentTextLimit, attachmentsByMessage.get(row.id) || []),
        toolCalls: parseToolCalls(row.tool_calls_json),
        toolCallId: row.tool_call_id || undefined
    }))

    return { historyRows, filteredRows, messages }
}

function buildHistoryContent(
    row: ChatHistoryRow,
    inlineAttachmentTextLimit: number,
    fileAttachments: FileAttachmentArtifact[],
): string | ContentPart[] {
    if (row.role !== 'user') return row.content

    const imageUrls = parseJsonArray<string>(row.image_urls_json).filter((url) => typeof url === 'string')
    const audioUrls = parseJsonArray<string>(row.audio_urls_json).filter((url) => typeof url === 'string')

    if (!fileAttachments.length && !imageUrls.length && !audioUrls.length) {
        return row.content
    }

    const parts: ContentPart[] = [{ type: 'text', text: row.content }]
    for (const file of fileAttachments) {
        if (file.textBytes > inlineAttachmentTextLimit) {
            const status = file.chunkCount && file.chunkCount > 0
                ? `This attachment is indexed for retrieval (${file.chunkCount} chunks, attachmentId: ${file.id}).`
                : `This attachment is larger than the inline context limit and will be indexed for retrieval (attachmentId: ${file.id}).`
            parts.push({
                type: 'text',
                text: `[Attached file: ${file.name}]\n${status} Use the current attachment context or attachment_search/attachment_retrieve_chunks when details are needed.`
            })
            continue
        }
        const fileText = readFileAttachmentText(file)
        if (fileText === null) continue
        parts.push({
            type: 'text',
            text: `[Attached file: ${file.name}]\n${fileText}`
        })
    }
    for (const url of imageUrls) {
        parts.push({ type: 'image_url', image_url: { url: localFileUrlToDataUrl(url) } })
    }
    for (const url of audioUrls) {
        parts.push({ type: 'audio_url', audio_url: { url } })
    }
    return parts
}

function localFileUrlToDataUrl(url: string): string {
    const filePath = extractFilePathFromFileUrl(url)
    if (!filePath || !existsSync(filePath)) return url
    try {
        const data = readFileSync(filePath).toString('base64')
        return `data:${imageMimeFromPath(filePath)};base64,${data}`
    } catch {
        return url
    }
}

function imageMimeFromPath(filePath: string): string {
    switch (extname(filePath).toLowerCase()) {
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg'
        case '.gif':
            return 'image/gif'
        case '.webp':
            return 'image/webp'
        case '.bmp':
            return 'image/bmp'
        case '.svg':
            return 'image/svg+xml'
        default:
            return 'image/png'
    }
}

function parseJsonArray<T>(json: string | null): T[] {
    if (!json) return []
    try {
        const parsed = JSON.parse(json)
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
}

function parseToolCalls(json: string | null): ToolCall[] | undefined {
    if (!json) return undefined
    try {
        const parsed = JSON.parse(json) as unknown
        return Array.isArray(parsed) ? parsed as ToolCall[] : undefined
    } catch {
        return undefined
    }
}
