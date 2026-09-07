import { nanoid } from 'nanoid'
import { getEventBus } from '../../telemetry/event-bus.js'
import { completeWithDebugCapture } from '../../chat/debug-context.js'
import type { LLMGateway } from '../../gateway/gateway.js'
import type { ChatMessage, ContentPart, ToolDefinition } from '../../gateway/providers/base.provider.js'

const TASK_CONTEXT_TOOL_NAME = 'set_task_context'
const TURN_CHAR_LIMIT = 500
const MAX_ROUTER_QUERY_LENGTH = 2_000
const MAX_MEMORY_EXPANSIONS = 2
/** Headroom for tool-call arguments plus any reasoning tokens some models emit despite /no_think. */
const TASK_CONTEXT_MAX_TOKENS = 1_500

export type RequestedToolEffect = 'read' | 'write' | 'destructive'

export interface TaskContext {
    toolQuery?: string
    /** Backwards-compatible primary expansion. The original request is always searched separately. */
    memoryQuery?: string
    memoryQueries: string[]
    requestedToolEffect: RequestedToolEffect
    /** Clear memory lookups do not need the external tool catalogue routed. */
    skipToolRouting: boolean
    fastPath?: boolean
}

export interface BuildTaskContextInput {
    conversationId: string
    userQuery?: string
    recentMessages?: ChatMessage[]
    gateway: LLMGateway
    providerId?: string
    model?: string
    enabledModes: {
        tools: boolean
        memories: boolean
    }
    eventMeta?: Record<string, unknown>
    signal?: AbortSignal
    debugContextEnabled?: boolean
}

export async function buildTaskContext(input: BuildTaskContextInput): Promise<TaskContext | null> {
    const currentRequest = input.userQuery?.trim()
    if (!currentRequest || !hasEnabledMode(input.enabledModes)) return null

    const taskId = `auto_router_${nanoid()}`
    emitTaskContextStatus(input.conversationId, taskId, input.eventMeta)

    const deterministic = buildDeterministicTaskContext(currentRequest, input.enabledModes)
    if (deterministic) {
        emitTaskContextSelection(input.conversationId, taskId, deterministic, input.eventMeta, undefined, 'deterministic')
        return deterministic
    }

    try {
        const request: Parameters<LLMGateway['complete']>[0] = {
            messages: [
                {
                    role: 'system',
                    content: [
                        'You prepare routing queries before the main assistant run.',
                        'Given the current request and recent conversation, call set_task_context with a structured retrieval plan.',
                        ...enabledQueryInstructions(input.enabledModes),
                        'The original request is always searched separately. Generate only complementary expansions.',
                        'Keep expansions in the request language and preserve exact names, quoted phrases, identifiers, relationship terms, and constraints.',
                        'Never broaden a specific relationship or operation into generic related topics.',
                        'toolQuery must describe only capabilities required to perform the request, not nouns merely mentioned in it.',
                        'Set requiresExternalTools=false when memory retrieval alone can answer the request.',
                        'Classify the maximum requested side effect as read, write, or destructive.',
                        'Do not include disabled auto modes.',
                        'Do not add execution instructions or answer the user.',
                        'Do not answer the user. Keep the context specific and omit irrelevant conversation details. /no_think',
                    ].join('\n'),
                },
                {
                    role: 'user',
                    content: [
                        `Enabled auto modes: ${enabledModeLabels(input.enabledModes).join(', ')}`,
                        '',
                        buildRecentConversationBlock(input.recentMessages || []),
                        '',
                        `Current request: ${currentRequest}`,
                    ].filter(Boolean).join('\n'),
                },
            ],
            model: input.model,
            maxTokens: TASK_CONTEXT_MAX_TOKENS,
            tools: [buildTaskContextTool(input.enabledModes)],
            toolChoice: { type: 'function', name: TASK_CONTEXT_TOOL_NAME },
            thinkingEnabled: false,
            signal: input.signal,
        }
        const result = await completeWithDebugCapture({
            enabled: input.debugContextEnabled,
            conversationId: input.conversationId,
            phase: 'task-context',
            label: 'Retrieval and tool query planning',
            gateway: input.gateway,
            providerId: input.providerId,
            request,
        })

        const contextCall = result.toolCalls?.find((call) => call.function.name === TASK_CONTEXT_TOOL_NAME)
        const parsed = contextCall ? parseTaskContextArguments(contextCall.function.arguments, input.enabledModes, currentRequest) : null
        emitTaskContextSelection(input.conversationId, taskId, parsed, input.eventMeta, parsed ? undefined : 'none-generated', 'llm')
        return parsed
    } catch (err) {
        if ((err as Error).name === 'AbortError' || input.signal?.aborted) throw err
        console.warn('[auto-router] Task context build failed, using original request in downstream routers:', err)
        emitTaskContextSelection(input.conversationId, taskId, null, input.eventMeta, 'routing-failed', 'llm')
        return null
    }
}

function buildTaskContextTool(enabledModes: BuildTaskContextInput['enabledModes']): ToolDefinition {
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    if (enabledModes.tools) {
        properties.toolQuery = {
            type: 'string',
            description: 'A compact semantic query optimized for selecting relevant tools and tool namespaces.',
        }
        required.push('toolQuery')
        properties.requestedToolEffect = {
            type: 'string',
            enum: ['read', 'write', 'destructive'],
            description: 'Maximum side effect explicitly required by the user request.',
        }
        properties.requiresExternalTools = {
            type: 'boolean',
            description: 'False when automatic memory context alone is sufficient and no external capability is required.',
        }
        required.push('requestedToolEffect', 'requiresExternalTools')
    }
    if (enabledModes.memories) {
        properties.memoryQueries = {
            type: 'array',
            description: 'Zero to two compact retrieval expansions in the original language. Do not repeat the original request.',
            items: { type: 'string' },
            maxItems: MAX_MEMORY_EXPANSIONS,
        }
        required.push('memoryQueries')
    }

    return {
        name: TASK_CONTEXT_TOOL_NAME,
        description: 'Set the mode-specific queries used to route automatic capabilities.',
        timeout: 10_000,
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties,
            required,
        },
        execute: async () => ({ success: true, output: 'ok' }),
    }
}

function parseTaskContextArguments(
    raw: string,
    enabledModes: BuildTaskContextInput['enabledModes'],
    originalRequest: string,
): TaskContext | null {
    try {
        const parsed = JSON.parse(raw) as {
            toolQuery?: unknown
            memoryQuery?: unknown
            memoryQueries?: unknown
            requestedToolEffect?: unknown
            requiresExternalTools?: unknown
        }
        const toolQuery = enabledModes.tools && typeof parsed.toolQuery === 'string' ? parsed.toolQuery.trim() : ''
        const legacyMemoryQuery = typeof parsed.memoryQuery === 'string' ? parsed.memoryQuery.trim() : ''
        const memoryQueries = enabledModes.memories
            ? normalizeMemoryQueries(Array.isArray(parsed.memoryQueries) ? parsed.memoryQueries : [legacyMemoryQuery])
            : []

        if (enabledModes.tools && !toolQuery) return null
        const modelEffect = isRequestedToolEffect(parsed.requestedToolEffect) ? parsed.requestedToolEffect : 'read'
        const requestedToolEffect = maxRequestedToolEffect(
            maxRequestedToolEffect(modelEffect, inferRequestedToolEffect(toolQuery)),
            inferRequestedToolEffect(originalRequest),
        )
        return {
            toolQuery: toolQuery ? toolQuery.slice(0, MAX_ROUTER_QUERY_LENGTH) : undefined,
            memoryQuery: memoryQueries[0],
            memoryQueries,
            requestedToolEffect,
            skipToolRouting: enabledModes.tools ? parsed.requiresExternalTools === false : true,
        }
    } catch {
        return null
    }
}

function normalizeMemoryQueries(values: unknown[]): string[] {
    return values
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim().slice(0, MAX_ROUTER_QUERY_LENGTH))
        .filter(Boolean)
        .filter((value, index, all) => all.indexOf(value) === index)
        .slice(0, MAX_MEMORY_EXPANSIONS)
}

function buildDeterministicTaskContext(
    request: string,
    enabledModes: BuildTaskContextInput['enabledModes'],
): TaskContext | null {
    if (!enabledModes.memories || !isClearMemoryLookup(request)) return null
    return {
        memoryQuery: request,
        memoryQueries: [],
        requestedToolEffect: 'read',
        skipToolRouting: true,
        fastPath: true,
    }
}

function isClearMemoryLookup(request: string): boolean {
    if (request.length > 240 || inferRequestedToolEffect(request) !== 'read') return false
    const normalized = request.toLocaleLowerCase()
    const personalReference = /\b(my|our|mine|meine|mein|meinen|meiner|unser|unsere|mich|mir)\b/i.test(normalized)
    const memoryReference = /\b(remember|memory|previous|prior|erinner|wei(?:ß|ss)t du|wei(?:ß|ss)t du noch|what do you know|was wei(?:ß|ss)t du)\b/i.test(normalized)
    return personalReference && memoryReference
}

export function inferRequestedToolEffect(request: string): RequestedToolEffect {
    const normalized = request.toLocaleLowerCase()
    if (/(delete|remove|erase|destroy|cancel|revoke|lösch|loesch|entfern|widerruf|kündig|kuendig)\w*/i.test(normalized)) {
        return 'destructive'
    }
    if (/\b(create|add|append|update|edit|change|write|save|send|post|upload|schedule|book|notify|reply|forward|erstell|hinzufüg|anfueg|aktualisier|änder|aender|schreib|speicher|send|verschick|buch|benachrichtig|antwort)\w*/i.test(normalized)) {
        return 'write'
    }
    return 'read'
}

function isRequestedToolEffect(value: unknown): value is RequestedToolEffect {
    return value === 'read' || value === 'write' || value === 'destructive'
}

function maxRequestedToolEffect(a: RequestedToolEffect, b: RequestedToolEffect): RequestedToolEffect {
    const rank: Record<RequestedToolEffect, number> = { read: 0, write: 1, destructive: 2 }
    return rank[a] >= rank[b] ? a : b
}

function buildRecentConversationBlock(messages: ChatMessage[]): string {
    const recent = messages
        .filter(({ role }) => role === 'user' || role === 'assistant')
        .slice(-5)

    if (!recent.length) return ''

    const context = recent
        .map(({ role, content }) => `${role}: ${messageContentForRouter(content).slice(0, TURN_CHAR_LIMIT)}`)
        .join('\n')

    return `Recent conversation:\n${context}`
}

function messageContentForRouter(content: string | ContentPart[]): string {
    if (typeof content === 'string') return content
    const text = content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
        .trim()
    return text || '[multipart content]'
}

function hasEnabledMode(modes: BuildTaskContextInput['enabledModes']): boolean {
    return modes.tools || modes.memories
}

function enabledModeLabels(modes: BuildTaskContextInput['enabledModes']): string[] {
    return [
        modes.tools ? 'tools' : '',
        modes.memories ? 'memories' : '',
    ].filter(Boolean)
}

function enabledQueryInstructions(modes: BuildTaskContextInput['enabledModes']): string[] {
    return [
        modes.tools
            ? '- toolQuery: what capabilities, services, filesystems, APIs, or operations should be selected as tools for this task.'
            : '',
        modes.memories
            ? '- memoryQueries: up to two precise alternative searches that complement the unchanged original request.'
            : '',
    ].filter(Boolean)
}

function emitTaskContextStatus(conversationId: string, taskId: string, eventMeta?: Record<string, unknown>): void {
    getEventBus().emit('step:status', {
        conversationId,
        taskId,
        iteration: 0,
        status: 'building-task-context',
        message: 'Building task context...',
        ...eventMeta,
    })
}

function emitTaskContextSelection(
    conversationId: string,
    taskId: string,
    context: TaskContext | null,
    eventMeta?: Record<string, unknown>,
    emptyReason?: 'none-generated' | 'routing-failed',
    selectionMethod: 'llm' | 'deterministic' = 'llm',
): void {
    getEventBus().emit('step:tools-chosen', {
        conversationId,
        taskId,
        iteration: 0,
        ...eventMeta,
        toolCalls: [{
            name: 'Task context',
            arguments: JSON.stringify(stripUndefined({
                type: 'task-context',
                selectionMethod,
                toolQuery: context?.toolQuery,
                memoryQuery: context?.memoryQuery,
                memoryQueries: context?.memoryQueries,
                requestedToolEffect: context?.requestedToolEffect,
                skipToolRouting: context?.skipToolRouting,
                fastPath: context?.fastPath,
                emptyReason,
                content: emptyReason ? taskContextEmptyContent(emptyReason) : undefined,
            })),
        }],
    })
}

function taskContextEmptyContent(reason: 'none-generated' | 'routing-failed'): string {
    if (reason === 'routing-failed') {
        return 'Preparing context failed; auto routing continued with the original user request.'
    }
    return 'Preparing context returned no valid routing queries; auto routing continued with the original user request.'
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}
