import Database from 'better-sqlite3'
import { COMPACT_EVENT_PREFIX } from '../agent/context-compactor.js'
import { artifactFileUrlToDataUrl, extractFilePathFromFileUrl } from '../artifacts/image-artifacts.js'
import { listConversationFileAttachmentsByMessage } from '../artifacts/attachment-rag.js'
import { readFileAttachmentText, type FileAttachmentArtifact } from '../artifacts/file-artifacts.js'
import { isTurnLocalContextMessage, type ChatMessage, type ContentPart, type ToolCall } from '../gateway/providers/base.provider.js'
import type { ContentBlock } from '@shared/types'
import { contentBlocksToProviderContent } from './transcript.js'

export interface ChatHistoryRow {
    id: string
    role: string
    is_error?: number
    content: string
    tool_calls_json: string | null
    tool_call_id: string | null
    agent_id: string | null
    content_blocks_json: string | null
    created_at: number
}

export interface BuiltChatHistory {
    historyRows: ChatHistoryRow[]
    filteredRows: ChatHistoryRow[]
    messages: ChatMessage[]
}

export function buildRecentImageArtifactsHint(rows: ChatHistoryRow[], limit = 5): string | null {
    const artifacts: { path: string; url: string }[] = []
    const seen = new Set<string>()

    for (let i = rows.length - 1; i >= 0 && artifacts.length < limit; i--) {
        const row = rows[i]
        if (row.role !== 'assistant') continue
        const urls = parseContentBlocks(row.content_blocks_json)
            .flatMap((block) => block.type === 'image' ? [block.url] : [])
        for (let j = urls.length - 1; j >= 0 && artifacts.length < limit; j--) {
            const url = urls[j]
            const path = extractFilePathFromFileUrl(url)
            if (!path || seen.has(path)) continue
            seen.add(path)
            artifacts.push({ path, url })
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

/**
 * Treat the image produced by the preceding assistant turn as the implicit edit
 * input for the active user turn. Explicitly attached user images remain in the
 * request as additional references. Crossing another user turn is deliberately
 * avoided so an old generated image does not unexpectedly become the base for
 * an unrelated chat.
 */
export function attachPreviousGeneratedImageToActiveUser(
    rows: ChatHistoryRow[],
    messages: ChatMessage[],
): ChatMessage[] {
    let activeUserRowIndex = -1
    for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].role === 'user') {
            activeUserRowIndex = i
            break
        }
    }
    if (activeUserRowIndex === -1) return messages

    let generatedImageUrl: string | null = null
    for (let i = activeUserRowIndex - 1; i >= 0; i--) {
        const row = rows[i]
        if (row.role === 'user') break
        if (row.role !== 'assistant') continue

        const urls = parseContentBlocks(row.content_blocks_json)
            .flatMap((block) => block.type === 'image' ? [block.url] : [])
        if (urls.length) generatedImageUrl = urls.at(-1) || null
        break
    }
    if (!generatedImageUrl) return messages

    let activeUserMessageIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
            activeUserMessageIndex = i
            break
        }
    }
    if (activeUserMessageIndex === -1) return messages

    const activeMessage = messages[activeUserMessageIndex]
    const existingParts = typeof activeMessage.content === 'string'
        ? [{ type: 'text' as const, text: activeMessage.content }]
        : activeMessage.content

    const providerUrl = artifactFileUrlToDataUrl(generatedImageUrl) || generatedImageUrl
    if (existingParts.some((part) => part.type === 'image_url' && part.image_url.url === providerUrl)) {
        return messages
    }

    // Keep the generated image ahead of explicitly attached images so providers
    // receive it as the primary edit base and the uploads as supporting references.
    const firstExplicitImageIndex = existingParts.findIndex((part) => part.type === 'image_url')
    const insertAt = firstExplicitImageIndex === -1 ? existingParts.length : firstExplicitImageIndex
    const nextMessages = [...messages]
    nextMessages[activeUserMessageIndex] = {
        ...activeMessage,
        content: [
            ...existingParts.slice(0, insertAt),
            { type: 'image_url', image_url: { url: providerUrl } },
            ...existingParts.slice(insertAt),
        ],
    }
    return nextMessages
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

export function insertTurnLocalUntrustedContext(
    messages: ChatMessage[],
    context: string | null,
    contextKind: string,
): ChatMessage[] {
    if (!context) return messages
    return insertTurnLocalContext(messages, [{
        role: 'user',
        content: context,
        metadata: { contextKind, untrusted: true },
    }])
}

/**
 * Place per-turn context directly before the active user message. The system
 * prompt and earlier history then stay byte-identical between turns, which is
 * what provider prompt caches match on.
 */
export function insertTurnLocalContext(messages: ChatMessage[], contextMessages: ChatMessage[]): ChatMessage[] {
    if (!contextMessages.length) return messages
    let activeUserIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user' && !isTurnLocalContextMessage(messages[i])) {
            activeUserIndex = i
            break
        }
    }

    if (activeUserIndex === -1) return [...messages, ...contextMessages]
    return [
        ...messages.slice(0, activeUserIndex),
        ...contextMessages,
        ...messages.slice(activeUserIndex),
    ]
}

/** Lead with the bundle's system messages and slot its turn-local messages in before the active request. */
export function assembleExecutionMessages(contextMessages: ChatMessage[], history: ChatMessage[]): ChatMessage[] {
    return insertTurnLocalContext(
        [...contextMessages.filter((message) => message.role === 'system'), ...history],
        contextMessages.filter((message) => message.role !== 'system'),
    )
}

/** Close interrupted tool rounds before replaying history to a provider. */
export function repairInterruptedToolRounds(messages: ChatMessage[]): ChatMessage[] {
    const result: ChatMessage[] = []
    const pending = new Set<string>()
    const closeRound = () => {
        for (const toolCallId of pending) {
            result.push({
                role: 'tool',
                toolCallId,
                content: 'Tool execution was interrupted before a result was recorded. No result is available.',
            })
        }
        pending.clear()
    }
    for (const message of messages) {
        if (message.role === 'tool') {
            // Orphaned, duplicate, and late results cannot be replayed as tool messages.
            if (!message.toolCallId || !pending.delete(message.toolCallId)) continue
            result.push(message)
            continue
        }
        closeRound()
        result.push(message)
        if (message.role === 'assistant') {
            for (const call of message.toolCalls ?? []) pending.add(call.id)
        }
    }
    closeRound()
    return result
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
            'SELECT id, role, is_error, content, tool_calls_json, tool_call_id, agent_id, content_blocks_json, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
        )
        .all(conversationId) as ChatHistoryRow[]
    const attachmentsByMessage = listConversationFileAttachmentsByMessage(db, conversationId)

    const keptToolCallIds = new Set<string>()
    const filteredRows = historyRows.filter((row) => {
        if (row.is_error) return false
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

    return { historyRows, filteredRows, messages: repairInterruptedToolRounds(messages) }
}

function buildHistoryContent(
    row: ChatHistoryRow,
    inlineAttachmentTextLimit: number,
    fileAttachments: FileAttachmentArtifact[],
): string | ContentPart[] {
    const canonicalBlocks = parseContentBlocks(row.content_blocks_json)
    const canonicalText = canonicalBlocks.flatMap((block) => block.type === 'text' ? [block.text] : []).join('')
    if (row.role !== 'user') return canonicalText

    const imageUrls = canonicalBlocks.flatMap((block) => block.type === 'image' ? [block.url] : [])
    const audioUrls = canonicalBlocks.flatMap((block) => block.type === 'audio' ? [block.url] : [])

    if (!fileAttachments.length && !imageUrls.length && !audioUrls.length) {
        return canonicalText
    }

    const blocks: ContentBlock[] = [{ type: 'text', text: canonicalText }]
    for (const file of fileAttachments) {
        if (file.textBytes > inlineAttachmentTextLimit) {
            const status = file.chunkCount && file.chunkCount > 0
                ? `This attachment is indexed for retrieval (${file.chunkCount} chunks, attachmentId: ${file.id}).`
                : `This attachment is larger than the inline context limit and will be indexed for retrieval (attachmentId: ${file.id}).`
            blocks.push({
                type: 'text',
                text: `[Attached file: ${file.name}]\n${status} Use the current attachment context or attachment_search/attachment_read when details are needed.`
            })
            continue
        }
        const fileText = readFileAttachmentText(file)
        if (fileText === null) continue
        blocks.push({
            type: 'text',
            text: `[Attached file: ${file.name}]\n${fileText}`
        })
    }
    for (const url of imageUrls) {
        blocks.push({ type: 'image', artifactId: url, url })
    }
    for (const url of audioUrls) {
        blocks.push({ type: 'audio', artifactId: url, url })
    }
    return contentBlocksToProviderContent(blocks, (url) => artifactFileUrlToDataUrl(url) || url)
}

function parseContentBlocks(json: string | null): ContentBlock[] {
    if (!json) return []
    try {
        const parsed = JSON.parse(json) as unknown
        return Array.isArray(parsed) ? parsed as ContentBlock[] : []
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
