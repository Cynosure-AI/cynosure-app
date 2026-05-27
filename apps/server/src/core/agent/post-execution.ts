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

export async function generateTitle(opts: GenerateTitleOpts): Promise<void> {
    const { conversationId, userMessage, assistantResponse, broadcast, providerId, model } = opts
    const gateway = getGateway()
    const db = getDb()

    const signal = startAction(conversationId, 'generating-title', broadcast)

    try {
        const userSnippet = userMessage.slice(0, 150)
        const assistantSnippet = assistantResponse.slice(0, 300)
        const titleTarget = resolveTitleTarget(gateway, providerId, model)

        const result = await gateway.complete({
            messages: [
                {
                    role: 'system' as const,
                    content: 'You are a chat title generator. Output only the title — 3 to 7 words, no punctuation at the end, no quotes, no explanation.'
                },
                {
                    role: 'user' as const,
                    content: `Write a short title for this conversation.\nUser: "${userSnippet}"\nAssistant: "${assistantSnippet}" /no_think`
                }
            ],
            model: titleTarget.model,
            signal,
            maxTokens: 30
        }, titleTarget.providerId)

        const raw = result.content?.trim()
        if (raw) {
            const title = raw
                .replace(/^["'""''`]+|["'""''`]+$/g, '')
                .replace(/^Title:\s*/i, '')
                .replace(/[.!?:;,]+$/, '')
                .replace(/\s{2,}/g, ' ')
                .trim()
                .slice(0, 80)

            if (title && title.split(/\s+/).length <= 10) {
                db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), conversationId)
                broadcast('chat:title-updated', { conversationId, title })
                return
            }
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
    const words = userMessage.split(/\s+/).slice(0, 6).join(' ')
    const fallback = words.length > 60 ? words.slice(0, 60) + '…' : words
    if (fallback) {
        db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(fallback, Date.now(), conversationId)
        broadcast('chat:title-updated', { conversationId, title: fallback })
    }
}
