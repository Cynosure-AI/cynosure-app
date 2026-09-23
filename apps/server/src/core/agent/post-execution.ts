/**
 * Centralised auxiliary-action registry and generators.
 *
 * Auxiliary actions are lightweight LLM calls that run around a chat or cron
 * execution. Interactive-chat title generation starts before the main agent
 * responds; other callers may schedule actions after their execution.
 *
 *  1. Tracks which post-actions are currently in-flight (server-side) so a
 *     frontend that hard-reloads can query the current state.
 *  2. Broadcasts WS events for real-time progress indicators.
 *  3. Houses generator functions so callers only need a one-liner.
 */

import { getDb } from '../../db/database.js'
import { getGateway } from '../gateway/gateway.js'
import type { LLMGateway } from '../gateway/gateway.js'
import { publishChatEvent } from '../chat/transcript.js'


type BroadcastFn = (event: string, data: unknown) => void

// ─── In-flight registry ────────────────────────────────────

/** conversationId → action name → number of in-flight generations. */
const activeActions = new Map<string, Map<string, number>>()

/** conversationId → AbortController shared by all post-actions for that conversation */
const abortControllers = new Map<string, AbortController>()

function getOrCreateAbortController(conversationId: string): AbortController {
    let ctrl = abortControllers.get(conversationId)
    if (!ctrl || ctrl.signal.aborted) {
        ctrl = new AbortController()
        abortControllers.set(conversationId, ctrl)
    }
    return ctrl
}

export function startAction(conversationId: string, action: string, broadcast: BroadcastFn): AbortSignal {
    let actions = activeActions.get(conversationId)
    if (!actions) {
        actions = new Map()
        activeActions.set(conversationId, actions)
    }
    actions.set(action, (actions.get(action) || 0) + 1)
    publishChatEvent(broadcast, { conversationId, executionId: 'external', payload: { type: 'post-action', action, status: 'started' } })
    return getOrCreateAbortController(conversationId).signal
}

export function completeAction(conversationId: string, action: string, broadcast: BroadcastFn): void {
    const actions = activeActions.get(conversationId)
    if (actions) {
        const remaining = (actions.get(action) || 0) - 1
        if (remaining > 0) {
            actions.set(action, remaining)
            return
        }
        actions.delete(action)
        if (actions.size === 0) {
            activeActions.delete(conversationId)
            abortControllers.delete(conversationId)
        }
    }
    publishChatEvent(broadcast, { conversationId, executionId: 'external', payload: { type: 'post-action', action, status: 'completed' } })
}

/** Cancel all in-flight post-actions for a conversation. */
export function cancelPostActions(conversationId: string): boolean {
    const ctrl = abortControllers.get(conversationId)
    if (ctrl && !ctrl.signal.aborted) {
        ctrl.abort()
        return true
    }
    return false
}

/** Return the active actions for a single conversation. */
export function getActiveActions(conversationId: string): string[] {
    return Array.from(activeActions.get(conversationId)?.keys() ?? [])
}

/** Return all active actions keyed by conversationId. */
export function getAllActiveActions(): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const [cid, actions] of activeActions) {
        out[cid] = Array.from(actions.keys())
    }
    return out
}

export interface QuickResponsesState {
    messageId: string | null
    suggestions: string[]
}

/** Return the latest durable suggestions for a conversation, if any. */
export function getQuickResponses(conversationId: string): QuickResponsesState {
    const row = getDb().prepare(
        `SELECT json_extract(CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END, '$.quickResponsesMessageId') AS message_id,
                json_extract(CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END, '$.quickResponses') AS suggestions_json
         FROM conversations WHERE id = ?`
    ).get(conversationId) as { message_id: string | null; suggestions_json: string | null } | undefined

    if (!row?.suggestions_json) return { messageId: null, suggestions: [] }
    try {
        const parsed = JSON.parse(row.suggestions_json)
        const latestAssistant = getDb().prepare(
            `SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant'
             ORDER BY created_at DESC, rowid DESC LIMIT 1`
        ).get(conversationId) as { id: string } | undefined
        if (!row.message_id || latestAssistant?.id !== row.message_id) {
            return { messageId: null, suggestions: [] }
        }
        return {
            messageId: row.message_id,
            suggestions: normalizeQuickResponses(parsed),
        }
    } catch {
        return { messageId: null, suggestions: [] }
    }
}

/** Remove stale suggestions as soon as a new turn begins. */
export function clearQuickResponses(conversationId: string, broadcast: BroadcastFn): void {
    getDb().prepare(
        `UPDATE conversations
         SET metadata_json = json_remove(CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END, '$.quickResponses', '$.quickResponsesMessageId')
         WHERE id = ?`
    ).run(conversationId)
    publishChatEvent(broadcast, { conversationId, executionId: 'external', payload: { type: 'quick-responses', messageId: null, suggestions: [] } })
}

export interface GenerateQuickResponsesOpts {
    conversationId: string
    messageId: string
    userMessage: string
    assistantResponse: string
    broadcast: BroadcastFn
    providerId?: string
    model?: string
}

const QUICK_RESPONSES_TIMEOUT_MS = 20_000
const QUICK_RESPONSES_MAX_TOKENS = 512

/** Generate short user-authored follow-ups without delaying the main response. */
export async function generateQuickResponses(opts: GenerateQuickResponsesOpts): Promise<void> {
    const { conversationId, messageId, userMessage, assistantResponse, broadcast, providerId, model } = opts
    const signal = startAction(conversationId, 'generating-quick-responses', broadcast)
    try {
        const gateway = getGateway()
        const target = resolveTitleTarget(gateway, providerId, model)
        const result = await gateway.complete({
            messages: [
                {
                    role: 'system' as const,
                    content: 'Suggest up to 3 concise, distinct messages the user could send next as follow-ups. Match the conversation and write each suggestion in the user\'s voice. Return only a JSON array of strings. Return [] when no useful follow-up exists.',
                },
                {
                    role: 'user' as const,
                    content: `User:\n${limitForQuickResponsePrompt(userMessage)}\n\nAssistant:\n${limitForQuickResponsePrompt(assistantResponse)}`,
                },
            ],
            model: target.model,
            signal: withTimeout(signal, QUICK_RESPONSES_TIMEOUT_MS),
            maxTokens: QUICK_RESPONSES_MAX_TOKENS,
            thinkingEnabled: false,
        }, target.providerId)
        signal.throwIfAborted()

        const suggestions = parseQuickResponses(result.content)
        // A newer turn may have started while this model call was finishing.
        const latestAssistant = getDb().prepare(
            `SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant'
             ORDER BY created_at DESC, rowid DESC LIMIT 1`
        ).get(conversationId) as { id: string } | undefined
        if (latestAssistant?.id !== messageId) return

        getDb().prepare(
            `UPDATE conversations
             SET metadata_json = json_set(CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
                 '$.quickResponses', json(?), '$.quickResponsesMessageId', ?)
             WHERE id = ?`
        ).run(JSON.stringify(suggestions), messageId, conversationId)
        publishChatEvent(broadcast, { conversationId, executionId: 'external', payload: { type: 'quick-responses', messageId, suggestions } })
    } catch (err) {
        if ((err as Error).name !== 'AbortError') {
            console.warn('[quick-responses] Generation failed:', err)
        }
    } finally {
        completeAction(conversationId, 'generating-quick-responses', broadcast)
    }
}

function limitForQuickResponsePrompt(value: string): string {
    const normalized = value.replace(/\s+/g, ' ').trim()
    return normalized.length <= 4_000 ? normalized : `${normalized.slice(0, 3_997)}…`
}

export function parseQuickResponses(rawContent: unknown): string[] {
    if (Array.isArray(rawContent)) return normalizeQuickResponses(rawContent)
    if (typeof rawContent !== 'string') return []
    const raw = rawContent.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    try {
        const parsed = JSON.parse(raw)
        return normalizeQuickResponses(Array.isArray(parsed) ? parsed : parsed?.suggestions)
    } catch {
        return normalizeQuickResponses(raw.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '')))
    }
}

function normalizeQuickResponses(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    const seen = new Set<string>()
    const suggestions: string[] = []
    for (const item of value) {
        if (typeof item !== 'string') continue
        const suggestion = item.replace(/\s+/g, ' ').trim().slice(0, 240).trim()
        const key = suggestion.toLocaleLowerCase()
        if (!suggestion || seen.has(key)) continue
        seen.add(key)
        suggestions.push(suggestion)
        if (suggestions.length === 3) break
    }
    return suggestions
}

// ─── Title generation ──────────────────────────────────────

export interface GenerateTitleOpts {
    conversationId: string
    userMessage: string
    assistantResponse: string
    broadcast: BroadcastFn
    providerId?: string
    model?: string
}

const MAX_TITLE_CHARS = 70
const MIN_TITLE_WORDS = 1
const MAX_TITLE_WORDS = 20
/** Hard cap on the title LLM call — a title should never take longer than this. */
const TITLE_TIMEOUT_MS = 15_000
/**
 * Includes headroom for providers that make reasoning mandatory. Although the
 * visible title is short, those models count hidden reasoning against the same
 * completion limit and can exhaust a tiny budget before emitting the title.
 */
const TITLE_MAX_TOKENS = 512

export async function generateTitle(opts: GenerateTitleOpts): Promise<void> {
    const { conversationId, userMessage, assistantResponse, broadcast, providerId, model } = opts
    const gateway = getGateway()
    const db = getDb()

    const signal = startAction(conversationId, 'generating-title', broadcast)

    // Give the chat a usable title immediately from the user message, then let
    // the LLM upgrade it in the background. This guarantees every conversation
    // has a proper title within milliseconds, regardless of model behaviour.
    const fallback = buildFallbackTitle(userMessage)
    if (fallback) {
        updateConversationTitle(db, conversationId, fallback, broadcast)
    }

    try {
        const titleTarget = resolveTitleTarget(gateway, providerId, model)

        const result = await gateway.complete({
            messages: buildTitleMessages(userMessage, assistantResponse),
            model: titleTarget.model,
            signal: withTimeout(signal, TITLE_TIMEOUT_MS),
            maxTokens: TITLE_MAX_TOKENS,
            thinkingEnabled: false
        }, titleTarget.providerId)

        const title = normalizeGeneratedTitle(result.content)
        // Only overwrite the fallback with a genuinely different, usable title.
        if (title && title.toLowerCase() !== fallback.toLowerCase()) {
            updateConversationTitle(db, conversationId, title, broadcast)
        }
    } catch (err) {
        if ((err as Error).name !== 'AbortError') {
            console.warn('[title] Title generation failed, keeping fallback title:', err)
        }
        // Fallback title was already applied above — nothing else to do.
    } finally {
        completeAction(conversationId, 'generating-title', broadcast)
    }
}

/** Combine the conversation abort signal with a hard timeout for the title call. */
function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(ms)
    if (typeof AbortSignal.any === 'function') {
        return AbortSignal.any([signal, timeoutSignal])
    }
    return timeoutSignal
}

function buildTitleMessages(userMessage: string, assistantResponse: string) {
    return [
        {
            role: 'system' as const,
            content: `You are a title and heading generator. Write a short title (3-${MAX_TITLE_WORDS} words) for this chat. Reply with the title only — no quotes, no punctuation at the end, no explanation. You basically only generate a title for a users input text.`
        },
        {
            role: 'user' as const,
            content: limitForTitlePrompt(userMessage, 800)
        }
    ]
}

function limitForTitlePrompt(value: string, maxChars: number): string {
    const normalized = normalizeSourceText(value)
    if (normalized.length <= maxChars) return normalized
    return normalized.slice(0, maxChars).replace(/\s+\S*$/, '').trim()
}

function normalizeSourceText(value: string): string {
    return value
        .replace(/```[\s\S]*?```/g, ' code block ')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/https?:\/\/\S+/gi, ' link ')
        .replace(/\s+/g, ' ')
        .trim()
}

function normalizeGeneratedTitle(rawContent: string | undefined): string | null {
    const title = cleanGeneratedTitle(extractTitleCandidate(rawContent))
    if (!isUsableTitle(title)) return null
    return title
}

function extractTitleCandidate(rawContent: string | undefined): string {
    const raw = (rawContent || '').trim()
    if (!raw) return ''

    return raw
        .replace(/^```(?:json|text)?/i, '')
        .replace(/```$/i, '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) || ''
}

function cleanGeneratedTitle(value: string): string {
    return value
        .replace(/^[-*#\d.)\s]+/, '')
        .replace(/^title\s*:\s*/i, '')
        .replace(/^["'""''`]+|["'""''`]+$/g, '')
        .replace(/[.!?:;,]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_TITLE_CHARS)
        .trim()
}

function isUsableTitle(title: string): boolean {
    if (!title) return false
    if (/[{}\[\]\n\r]/.test(title)) return false

    const words = title.split(/\s+/).filter(Boolean)
    if (words.length < MIN_TITLE_WORDS || words.length > MAX_TITLE_WORDS) return false
    return true
}

function resolveTitleTarget(
    gateway: LLMGateway,
    providerId?: string,
    model?: string
): { providerId: string; model: string } {
    const provider = providerId
        ? gateway.getProvider(providerId) || gateway.getLastUsedProvider()
        : gateway.getLastUsedProvider()

    return {
        providerId: provider.config.id,
        model: model || provider.config.defaultModel
    }
}

export function buildFallbackTitle(userMessage: string): string {
    const text = normalizeSourceText(userMessage)
        .replace(/^(please\s+)?(can|could|would)\s+you\s+/i, '')
        .replace(/^(please\s+)?(help\s+me\s+|i\s+need\s+(you\s+to\s+)?|i\s+want\s+(you\s+to\s+)?)/i, '')
        .trim()

    const sentence = text.split(/[.!?\n]/).find((part) => part.trim())?.trim() || text
    const intentMatch = sentence.match(/\b(fix|debug|repair|resolve|rework|refactor|implement|add|create|build|update|improve|design|explain|review|write|summarize)\b\s+(.+)/i)

    const phrase = intentMatch
        ? `${intentMatch[1]} ${intentMatch[2]}`
        : sentence

    const words = phrase
        .replace(/[^\p{L}\p{M}\p{N}+#.\s-]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter((word) => !/^(the|a|an|to|for|of|in|on|and|or|but|with|from|that|this|it|is|are)$/i.test(word))
        .slice(0, MAX_TITLE_WORDS)

    const fallback = toTitleCase(words.join(' '))
    return fallback.length > MAX_TITLE_CHARS ? fallback.slice(0, MAX_TITLE_CHARS).trim() : fallback
}

function toTitleCase(value: string): string {
    return value.replace(/\p{L}[\p{L}\p{M}\p{N}+#.-]*/gu, (word) => {
        if (/[\p{Lu}\p{N}+#.]/u.test(word.slice(1))) return word
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    })
}

function updateConversationTitle(
    db: ReturnType<typeof getDb>,
    conversationId: string,
    title: string,
    broadcast: BroadcastFn
): void {
    db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), conversationId)
    publishChatEvent(broadcast, { conversationId, executionId: 'external', payload: { type: 'title-updated', title } })
}
