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
import { makeGenerateTitleTool } from '../tools/built-in-tools.js'
import type { LLMGateway } from '../gateway/gateway.js'
import type { CompletionResponse } from '../gateway/providers/base.provider.js'

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
    const titleTool = makeGenerateTitleTool({ conversationId, broadcast })

    const signal = startAction(conversationId, 'generating-title', broadcast)

    try {
        const userSnippet = userMessage.slice(0, 150)
        const assistantSnippet = assistantResponse.slice(0, 300)
        const titleTarget = resolveTitleTarget(gateway, providerId, model)

        const messages = [
            {
                role: 'system' as const,
                content: 'Generate a short, descriptive chat title for this conversation. Prefer 3-7 words. Do not copy the first words verbatim unless they are already the best summary. /no_think'
            },
            {
                role: 'user' as const,
                content: `User: "${userSnippet}"\nAssistant: "${assistantSnippet}"`
            }
        ]

        let result: CompletionResponse
        try {
            result = await gateway.complete({
                messages: [
                    {
                        role: 'system',
                        content: `${messages[0].content} Call the generate_title tool with your title.`
                    },
                    messages[1]
                ],
                model: titleTarget.model,
                signal,
                tools: [titleTool],
                toolChoice: { type: 'function', name: 'generate_title' },
                maxTokens: 80
            }, titleTarget.providerId)
        } catch (err) {
            if ((err as Error).name === 'AbortError') throw err
            console.warn('[title] Structured title generation failed, retrying without tool call:', err)
            result = await gateway.complete({
                messages: [
                    {
                        role: 'system',
                        content: `${messages[0].content} Return only the title text, with no quotes or explanation.`
                    },
                    messages[1]
                ],
                model: titleTarget.model,
                signal,
                maxTokens: 80
            }, titleTarget.providerId)
        }

        if (result.toolCalls?.length) {
            for (const tc of result.toolCalls) {
                if (tc.function.name === 'generate_title') {
                    const args = JSON.parse(tc.function.arguments)
                    await titleTool.execute(args)
                    return
                }
            }
        }

        // Fallback: parse plain-text response
        if (result.content) {
            const raw = result.content
                .replace(/<think>[\s\S]*?<\/think>/gi, '')
                .replace(/\*{1,3}/g, '')
                .replace(/`{1,3}/g, '')
                .replace(/^#+\s*/gm, '')
            const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0 && l.length < 80)
            const candidate = lines[lines.length - 1] || ''
            const title = candidate
                .replace(/^["'""''`]+|["'""''`]+$/g, '')
                .replace(/^Title:\s*/i, '')
                .replace(/[.!?:;,]+$/, '')
                .replace(/\s{2,}/g, ' ')
                .trim()
                .slice(0, 80)

            if (title && title.split(/\s+/).length <= 10) {
                await titleTool.execute({ title })
                return
            }
        }

        // Final fallback: first words of user message
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
