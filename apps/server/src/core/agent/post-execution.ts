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


type BroadcastFn = (event: string, data: unknown) => void

// ─── In-flight registry ────────────────────────────────────

/** conversationId → Set of action names currently in progress */
const activeActions = new Map<string, Set<string>>()

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
    let set = activeActions.get(conversationId)
    if (!set) {
        set = new Set()
        activeActions.set(conversationId, set)
    }
    set.add(action)
    broadcast('chat:post-action', { conversationId, action, status: 'started' })
    return getOrCreateAbortController(conversationId).signal
}

export function completeAction(conversationId: string, action: string, broadcast: BroadcastFn): void {
    const set = activeActions.get(conversationId)
    if (set) {
        set.delete(action)
        if (set.size === 0) {
            activeActions.delete(conversationId)
            abortControllers.delete(conversationId)
        }
    }
    broadcast('chat:post-action', { conversationId, action, status: 'completed' })
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
    return Array.from(activeActions.get(conversationId) ?? [])
}

/** Return all active actions keyed by conversationId. */
export function getAllActiveActions(): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const [cid, set] of activeActions) {
        out[cid] = Array.from(set)
    }
    return out
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
            content: `Write a short title (3-${MAX_TITLE_WORDS} words) for this chat. Reply with the title only — no quotes, no punctuation at the end, no explanation.`
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

function applyFallbackTitle(
    db: ReturnType<typeof getDb>,
    conversationId: string,
    userMessage: string,
    broadcast: BroadcastFn
): void {
    const fallback = buildFallbackTitle(userMessage)
    if (fallback) {
        updateConversationTitle(db, conversationId, fallback, broadcast)
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
    broadcast('chat:title-updated', { conversationId, title })
}
