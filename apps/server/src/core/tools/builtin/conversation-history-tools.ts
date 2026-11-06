import type { MessageSearchHit } from '@shared/types'
import { getDb } from '../../../db/database.js'
import {
    listRecentConversations,
    searchMessages,
    SNIPPET_MATCH_END,
    SNIPPET_MATCH_START,
    type MessageSearchOptions,
} from '../../chat/message-search.js'
import type { ToolDefinition, ToolResult } from '../../gateway/providers/base.provider.js'
import { TOOL_OUTPUT_LIMITS } from '../../runtime-limits.js'
import { getConversationSearchConfig } from '../../chat/conversation-search-settings.js'

const DEFAULT_SEARCH_RESULTS = 10
const MAX_SEARCH_RESULTS = 25
const DEFAULT_WINDOW = 6
const MAX_WINDOW = 20
const MIN_MESSAGE_CHARS = 800
const MAX_MESSAGE_CHARS = 6_000
/** Leave room under the inline limit so these results are never saved to session content. */
const OUTPUT_BUDGET = TOOL_OUTPUT_LIMITS.inlineChars - 2_000
const DAY_MS = 24 * 60 * 60 * 1000

export interface ConversationHistoryToolOptions {
    /** The conversation running the tools; it is never searched or read. */
    conversationId: string
    /** Limit to this agent's conversations. Undefined searches every conversation (Cyno). */
    agentId?: string
}

/** The tools are offered when the user enabled them and the conversation is not incognito. */
export function isConversationHistoryAvailable(conversationId: string): boolean {
    if (!getConversationSearchConfig().enabled) return false
    if (!conversationId) return true
    const row = getDb().prepare('SELECT temporary FROM conversations WHERE id = ?').get(conversationId) as { temporary: number } | undefined
    return !row?.temporary
}

/** Added to the system prompt when the tools are offered. */
export const CONVERSATION_HISTORY_PROMPT = 'You can search the user\'s past conversations with conversation_search and read them with conversation_read. Use them when the user refers to an earlier chat or when prior context would clearly help; say which conversation an answer comes from.'

function toInteger(value: unknown): number | undefined {
    const number = typeof value === 'string' && value.trim() ? Number(value) : value
    return typeof number === 'number' && Number.isFinite(number) ? Math.floor(number) : undefined
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
    return Math.min(Math.max(value ?? fallback, min), max)
}

function pad(value: number): string {
    return String(value).padStart(2, '0')
}

/** Local date and time, e.g. 2026-11-06 14:05. */
export function formatTimestamp(ms: number): string {
    const date = new Date(ms)
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Parse a since/until bound: an ISO date or date-time, or a relative age such as
 * "7d", "2w", "3m" or "12h" (that long before now). A bare date used as an
 * upper bound covers the whole day. Returns null when the text is not a date.
 */
export function parseTimeBound(value: unknown, bound: 'since' | 'until', now = Date.now()): number | null | undefined {
    if (value === undefined || value === null || value === '') return undefined
    if (typeof value !== 'string') return null
    const text = value.trim()
    const relative = /^(\d+)\s*(h|d|w|m|y)$/i.exec(text)
    if (relative) {
        const amount = Number(relative[1])
        const unit = relative[2].toLowerCase()
        const hours = { h: 1, d: 24, w: 24 * 7, m: 24 * 30, y: 24 * 365 }[unit as 'h' | 'd' | 'w' | 'm' | 'y']
        return now - amount * hours * 60 * 60 * 1000
    }
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
    if (dateOnly) {
        const start = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])).getTime()
        if (!Number.isFinite(start)) return null
        return bound === 'until' ? start + DAY_MS : start
    }
    const parsed = Date.parse(text)
    return Number.isFinite(parsed) ? parsed : null
}

function highlight(snippet: string): string {
    return snippet
        .replaceAll(SNIPPET_MATCH_START, '**')
        .replaceAll(SNIPPET_MATCH_END, '**')
        .replace(/\s+/g, ' ')
        .trim()
}

function renderHit(hit: MessageSearchHit, index: number, mode: 'search' | 'recent'): string {
    const count = mode === 'search'
        ? `${hit.matchCount} matching message${hit.matchCount === 1 ? '' : 's'}`
        : `${hit.matchCount} message${hit.matchCount === 1 ? '' : 's'} in range`
    return [
        `${index + 1}. "${hit.title?.trim() || 'Untitled'}" · ${formatTimestamp(hit.createdAt)} · ${count}`,
        `   conversationId: ${hit.conversationId} · messageId: ${hit.messageId} · ${hit.role}`,
        `   ${highlight(hit.snippet)}`,
    ].join('\n')
}

interface ConversationRow { id: string; title: string | null; agent_id: string | null; temporary: number }
interface MessageRow { id: string; role: 'user' | 'assistant'; created_at: number }

function describeRange(since?: number, until?: number): string {
    if (since === undefined && until === undefined) return ''
    if (until === undefined) return ` since ${formatTimestamp(since!)}`
    if (since === undefined) return ` before ${formatTimestamp(until)}`
    return ` between ${formatTimestamp(since)} and ${formatTimestamp(until)}`
}

/** Search and read the user's past conversations. Incognito chats and the current chat are never visible. */
export function makeConversationHistoryTools(options: ConversationHistoryToolOptions): ToolDefinition[] {
    const { conversationId, agentId } = options
    const scope: MessageSearchOptions = { agentId, excludeConversationId: conversationId }
    const whose = agentId === undefined ? 'the user\'s past conversations' : 'your past conversations with the user'

    function loadConversation(id: string): ConversationRow | 'not-visible' | undefined {
        const row = getDb().prepare('SELECT id, title, agent_id, temporary FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined
        if (!row) return undefined
        if (row.temporary || row.id === conversationId) return 'not-visible'
        if (agentId !== undefined && row.agent_id !== agentId) return 'not-visible'
        return row
    }

    const search: ToolDefinition = {
        name: 'conversation_search',
        execution: { readOnly: true },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: `Search ${whose} by keyword. Use it when the user refers to something discussed before ("what did we decide about…", "like last time"), or when earlier context would clearly help. Returns the best matching message per conversation with its conversationId and messageId; read the surrounding messages with conversation_read before relying on a snippet. Search with a few distinctive words (names, technical terms), not whole sentences. Every word must match, so if nothing is found, retry with fewer words or synonyms, including in the language the user wrote in. "Quoted text" matches an exact phrase. Omit query to list conversations by recent activity, optionally within since/until. The current conversation and incognito chats are never included.`,
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Keywords to find, for example "postgres migration" or "\\"quarterly report\\"". Omit to list recent conversations.' },
                limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_RESULTS, description: `Maximum conversations to return (default ${DEFAULT_SEARCH_RESULTS}).` },
                since: { type: 'string', description: 'Only messages from this time on: an ISO date such as "2026-10-01", or a relative age such as "7d", "2w", "3m".' },
                until: { type: 'string', description: 'Only messages before this time: an ISO date (a bare date includes that whole day) or a relative age such as "30d".' },
            },
        },
        timeout: 30_000,
        execute: async (params: unknown): Promise<ToolResult> => {
            const args = (params ?? {}) as Record<string, unknown>
            const since = parseTimeBound(args.since, 'since')
            const until = parseTimeBound(args.until, 'until')
            if (since === null || until === null) {
                return { success: false, output: `Could not read "${since === null ? args.since : args.until}" as a time. Use an ISO date such as "2026-10-01" or a relative age such as "7d". Example: conversation_search {"query": "invoice", "since": "30d"}` }
            }
            const limit = clamp(toInteger(args.limit), DEFAULT_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS)
            const query = typeof args.query === 'string' ? args.query.trim() : ''
            const range = describeRange(since, until)
            const db = getDb()

            if (!query) {
                const hits = listRecentConversations(db, limit, { ...scope, since, until })
                if (!hits.length) return { success: true, output: `No past conversations${range}.` }
                return {
                    success: true,
                    output: `${hits.length} conversation${hits.length === 1 ? '' : 's'}${range}, most recently active first (snippet: first user message):\n\n${hits.map((hit, index) => renderHit(hit, index, 'recent')).join('\n\n')}\n\nRead one: conversation_read {"conversationId": "${hits[0].conversationId}"}`,
                }
            }

            let hits = searchMessages(db, query, limit, { ...scope, since, until })
            let note = ''
            if (!hits.length && /\s/.test(query)) {
                hits = searchMessages(db, query, limit, { ...scope, since, until, match: 'any' })
                if (hits.length) note = ' (no conversation matched every word, so these match any of them)'
            }
            if (!hits.length) {
                return { success: true, output: `No past conversations${range} match "${query}". Try fewer or different words, synonyms, another language, or a wider time range.` }
            }
            const top = hits[0]
            return {
                success: true,
                output: `${hits.length} conversation${hits.length === 1 ? '' : 's'}${range} match "${query}"${note}:\n\n${hits.map((hit, index) => renderHit(hit, index, 'search')).join('\n\n')}\n\nRead around a match: conversation_read {"conversationId": "${top.conversationId}", "messageId": "${top.messageId}"}`,
            }
        },
    }

    const read: ToolDefinition = {
        name: 'conversation_read',
        execution: { readOnly: true },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: `Read messages of a past conversation found with conversation_search. Returns the user and assistant messages around messageId (window messages before and after it), or the start of the conversation when messageId is omitted. Follow the "More before/after" hints to keep reading.`,
        parameters: {
            type: 'object',
            properties: {
                conversationId: { type: 'string', description: 'conversationId from a conversation_search result. Required.' },
                messageId: { type: 'string', description: 'messageId to read around. Omit to read from the start.' },
                window: { type: 'integer', minimum: 0, maximum: MAX_WINDOW, description: `Messages to show before and after messageId (default ${DEFAULT_WINDOW}).` },
            },
            required: ['conversationId'],
        },
        timeout: 30_000,
        execute: async (params: unknown): Promise<ToolResult> => {
            const args = (params ?? {}) as Record<string, unknown>
            const id = typeof args.conversationId === 'string' ? args.conversationId.trim() : ''
            if (!id) return { success: false, output: 'Missing "conversationId": take it from a conversation_search result, for example conversation_read {"conversationId": "…", "messageId": "…"}.' }
            const conversation = loadConversation(id)
            if (!conversation) return { success: false, output: `No conversation "${id}". Find one with conversation_search first.` }
            if (conversation === 'not-visible') return { success: false, output: `Conversation "${id}" cannot be read: it is the current conversation, an incognito chat, or outside your conversations.` }

            const db = getDb()
            const messages = db.prepare(`
                SELECT id, role, created_at FROM messages
                WHERE conversation_id = ? AND role IN ('user', 'assistant') AND content <> ''
                ORDER BY created_at, rowid
            `).all(id) as MessageRow[]
            const title = conversation.title?.trim() || 'Untitled'
            if (!messages.length) return { success: true, output: `"${title}" (${id}) has no messages to read.` }

            const window = clamp(toInteger(args.window), DEFAULT_WINDOW, 0, MAX_WINDOW)
            const messageId = typeof args.messageId === 'string' ? args.messageId.trim() : ''
            let center = 0
            let start = 0
            let end = Math.min(messages.length, window * 2 + 1)
            if (messageId) {
                center = messages.findIndex((message) => message.id === messageId)
                if (center === -1) {
                    return { success: false, output: `Message "${messageId}" is not a user or assistant message of "${title}" (${id}). Omit messageId to read from the start: conversation_read {"conversationId": "${id}"}` }
                }
                start = Math.max(0, center - window)
                end = Math.min(messages.length, center + window + 1)
            }

            const selected = messages.slice(start, end)
            const contents = new Map((db.prepare(`SELECT id, content FROM messages WHERE id IN (${selected.map(() => '?').join(', ')})`)
                .all(...selected.map((message) => message.id)) as Array<{ id: string; content: string }>)
                .map((row) => [row.id, row.content]))
            const perMessage = Math.min(MAX_MESSAGE_CHARS, Math.max(MIN_MESSAGE_CHARS, Math.floor(OUTPUT_BUDGET / selected.length) - 80))
            const rendered = selected.map((message) => {
                const content = (contents.get(message.id) ?? '').trim()
                const text = content.length > perMessage
                    ? `${content.slice(0, perMessage)}… [${(content.length - perMessage).toLocaleString('en-US')} more characters]`
                    : content
                const marker = messageId && message.id === messageId ? ' ← match' : ''
                return `[${message.id}] ${message.role} · ${formatTimestamp(message.created_at)}${marker}\n${text}`
            })

            const span = Math.max(window, 1)
            const hints: string[] = []
            if (start > 0) {
                const target = messages[Math.max(0, start - 1 - span)]
                hints.push(`[More before: conversation_read {"conversationId": "${id}", "messageId": "${target.id}", "window": ${span}}]`)
            }
            if (end < messages.length) {
                const target = messages[Math.min(messages.length - 1, end + span)]
                hints.push(`[More after: conversation_read {"conversationId": "${id}", "messageId": "${target.id}", "window": ${span}}]`)
            }
            if (!hints.length) hints.push('[This is the whole conversation.]')
            const header = `"${title}" (${id}), messages ${start + 1}–${end} of ${messages.length}:`
            return { success: true, output: `${header}\n\n${rendered.join('\n\n')}\n\n${hints.join('\n')}` }
        },
    }

    return [search, read]
}
