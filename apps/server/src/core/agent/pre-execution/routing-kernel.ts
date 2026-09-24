import { getEventBus } from '../../telemetry/event-bus.js'
import { recordAuxiliaryModelUsage } from '../../usage-metering.js'
import type { LLMGateway } from '../../gateway/gateway.js'
import type { ChatMessage } from '../../gateway/providers/base.provider.js'
import type { ChatEventDraft } from '@shared/types'

export interface RoutingContext {
    query: string
    recentMessages: ChatMessage[]
}

export function messageContentForRouter(content: ChatMessage['content']): string {
    if (typeof content === 'string') return content
    const text = content.filter((part) => part.type === 'text').map((part) => part.text).join('\n').trim()
    return text || '[multipart content]'
}

export function recentConversationBlock(messages: ChatMessage[], turnCharLimit: number, windowSize = 5): string {
    const recent = messages.filter(({ role }) => role === 'user' || role === 'assistant').slice(-windowSize)
    if (!recent.length) return ''
    const context = recent.map(({ role, content }) => `${role}: ${messageContentForRouter(content).slice(0, turnCharLimit)}`).join('\n')
    return `Recent conversation:\n${context}`
}

export function routerQuery(context: RoutingContext, turnCharLimit: number, windowSize = 5): string {
    const history = recentConversationBlock(context.recentMessages, turnCharLimit, windowSize)
    return history ? `${history}\n\nCurrent request: ${context.query}` : context.query
}

/** An explicit empty list is valid; a list containing only unknown IDs is not. */
export function parseCandidateIds(value: unknown, candidates: readonly string[], limit: number): string[] | null {
    if (!Array.isArray(value)) return null
    const requested = value.filter((id): id is string => typeof id === 'string')
    const allowed = new Set(candidates)
    const selected = [...new Set(requested.filter((id) => allowed.has(id)))].slice(0, limit)
    return requested.length && !selected.length ? null : selected
}

export async function selectRoutingCandidates<T>(input: {
    conversationId: string
    gateway: LLMGateway
    providerId?: string
    model?: string
    signal?: AbortSignal
    usageKind?: 'tool-router' | 'memory-router'
    toolName: string
    request: Parameters<LLMGateway['complete']>[0]
    parse: (raw: string) => T | null
}): Promise<T | null> {
    const result = await input.gateway.complete(input.request, input.providerId)
    input.signal?.throwIfAborted()
    if (input.usageKind) {
        recordAuxiliaryModelUsage({
            kind: input.usageKind,
            provider: input.providerId || '',
            model: result.model || input.model || '',
            inputTokens: result.usage?.promptTokens,
            outputTokens: result.usage?.completionTokens,
        })
    }
    const call = result.toolCalls?.find((item) => item.function.name === input.toolName)
    return call ? input.parse(call.function.arguments) : null
}

export async function runRoutingPhase<T>(input: {
    signal?: AbortSignal
    label: string
    run: () => Promise<T>
    fallback: (error: unknown) => T | Promise<T>
}): Promise<T> {
    try {
        input.signal?.throwIfAborted()
        return await input.run()
    } catch (error) {
        if ((error as Error).name === 'AbortError' || input.signal?.aborted) throw error
        console.warn(`[${input.label}] Routing failed:`, error)
        return input.fallback(error)
    }
}

export interface RoutingDecision {
    conversationId: string
    taskId: string
    phase: 'task-context' | 'toolsets' | 'tools' | 'memory-candidates' | 'memory-context'
    eventMeta?: Record<string, unknown>
    entries: Array<{ name: string; details: Record<string, unknown> }>
    empty: { name: string; details: Record<string, unknown> }
}

/** Emit one typed decision for each routing stage into the versioned chat event stream. */
export function emitRoutingDecision(decision: RoutingDecision): void {
    getEventBus().emit('chat:event', {
        conversationId: decision.conversationId,
        executionId: typeof decision.eventMeta?.executionId === 'string' ? decision.eventMeta.executionId : decision.taskId,
        payload: {
            type: 'routing-decision',
            taskId: decision.taskId,
            phase: decision.phase,
            entries: decision.entries.length ? decision.entries : [decision.empty],
            maCodename: typeof decision.eventMeta?.maCodename === 'string' ? decision.eventMeta.maCodename : undefined,
            maAgentName: typeof decision.eventMeta?.maAgentName === 'string' ? decision.eventMeta.maAgentName : undefined,
            parentInvocationId: typeof decision.eventMeta?.maInvocationId === 'string' ? decision.eventMeta.maInvocationId : undefined,
        },
    } satisfies ChatEventDraft)
}
