/**
 * Centralised post-action registry & generators.
 *
 * Post-actions are lightweight follow-up LLM calls that run after the main
 * chat / cron execution (e.g. title generation).  This module:
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
const MIN_TITLE_WORDS = 2
const MAX_TITLE_WORDS = 8
// Some models use part of the completion budget for hidden reasoning even when
// thinking is disabled. The title validator below still limits visible output.
const TITLE_MAX_TOKENS = 256

export async function generateTitle(opts: GenerateTitleOpts): Promise<void> {
    const { conversationId, userMessage, assistantResponse, broadcast, providerId, model } = opts
    const gateway = getGateway()
    const db = getDb()

    const signal = startAction(conversationId, 'generating-title', broadcast)

    try {
        const titleTarget = resolveTitleTarget(gateway, providerId, model)

        const result = await gateway.complete({
            messages: buildTitleMessages(userMessage, assistantResponse),
            model: titleTarget.model,
            signal,
            maxTokens: TITLE_MAX_TOKENS,
            thinkingEnabled: false
        }, titleTarget.providerId)

        const title = normalizeGeneratedTitle(result.content, userMessage)
        if (title) {
            updateConversationTitle(db, conversationId, title, broadcast)
            return
        }

        applyFallbackTitle(db, conversationId, userMessage, broadcast)
    } catch (err) {
        if ((err as Error).name !== 'AbortError') {
            console.warn('[title] Title generation failed, using fallback title:', err)
        }
        applyFallbackTitle(db, conversationId, userMessage, broadcast)
    } finally {
        completeAction(conversationId, 'generating-title', broadcast)
    }
}

function buildTitleMessages(userMessage: string, assistantResponse: string) {
    return [
        {
            role: 'system' as const,
            content: [
                'You create concise, useful chat sidebar titles.',
                `Return exactly one title, ${MIN_TITLE_WORDS}-${MAX_TITLE_WORDS} words, no quotes, no trailing punctuation.`,
                'Name the actual task or topic. Do not copy the opening words of the user message.',
                'Prefer noun phrases such as "Postgres Migration Plan" or action phrases such as "Fix OAuth Callback Error".',
                'Avoid vague titles: "Help With Code", "Question About This", "User Request", "Conversation Summary".'
            ].join('\n')
        },
        {
            role: 'user' as const,
            content: [
                'Create a title for this conversation.',
                '',
                '<user_message>',
                limitForTitlePrompt(userMessage, 1200),
                '</user_message>',
                '',
                '<assistant_response>',
                limitForTitlePrompt(assistantResponse, 1600),
                '</assistant_response>'
            ].join('\n')
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

function normalizeGeneratedTitle(rawContent: string | undefined, userMessage: string): string | null {
    const title = cleanGeneratedTitle(extractTitleCandidate(rawContent))
    if (!isUsableTitle(title, userMessage)) return null
    return title
}

function extractTitleCandidate(rawContent: string | undefined): string {
    const raw = (rawContent || '').trim()
    if (!raw) return ''

    const jsonTitle = parseJsonTitle(raw)
    if (jsonTitle) return jsonTitle

    return raw
        .replace(/^```(?:json|text)?/i, '')
        .replace(/```$/i, '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) || ''
}

function parseJsonTitle(raw: string): string | null {
    try {
        const parsed = JSON.parse(raw) as { title?: unknown }
        return typeof parsed.title === 'string' ? parsed.title : null
    } catch {
        return null
    }
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

function isUsableTitle(title: string, userMessage: string): boolean {
    if (!title) return false
    if (/[{}\[\]\n\r]/.test(title)) return false

    const words = title.split(/\s+/).filter(Boolean)
    if (words.length < MIN_TITLE_WORDS || words.length > MAX_TITLE_WORDS) return false

    const lowered = title.toLowerCase()
    if (/^(help|question|request|conversation|chat|user request|summary)\b/.test(lowered)) return false
    if (isCopiedOpening(title, userMessage)) return false

    return true
}

function isCopiedOpening(title: string, userMessage: string): boolean {
    const titleWords = toComparableWords(title)
    if (titleWords.length > 5) return false

    const openingWords = toComparableWords(userMessage).slice(0, titleWords.length)
    return titleWords.length > 0 && titleWords.join(' ') === openingWords.join(' ')
}

function toComparableWords(value: string): string[] {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
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
        .replace(/[^a-zA-Z0-9+#.\s-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter((word) => !/^(the|a|an|to|for|of|in|on|and|or|but|with|from|that|this|it|is|are)$/i.test(word))
        .slice(0, MAX_TITLE_WORDS)

    const fallback = toTitleCase(words.join(' '))
    return fallback.length > MAX_TITLE_CHARS ? fallback.slice(0, MAX_TITLE_CHARS).trim() : fallback
}

function toTitleCase(value: string): string {
    return value.replace(/\b[a-z][a-z0-9+#.-]*/gi, (word) => {
        if (/[A-Z0-9+#.]/.test(word.slice(1))) return word
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
