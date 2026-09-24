import { nanoid } from 'nanoid'
import { getEventBus } from '../../telemetry/event-bus.js'
import type { LLMGateway } from '../../gateway/gateway.js'
import type { ChatMessage, ToolDefinition } from '../../gateway/providers/base.provider.js'
import { emitRoutingDecision, recentConversationBlock, runRoutingPhase, selectRoutingCandidates } from './routing-kernel.js'

const TASK_CONTEXT_TOOL_NAME = 'set_task_context'
const TURN_CHAR_LIMIT = 500
const MAX_ROUTER_QUERY_LENGTH = 2_000
const MAX_MEMORY_EXPANSIONS = 2
/** Headroom for tool-call arguments plus any reasoning tokens some models emit despite /no_think. */
const TASK_CONTEXT_MAX_TOKENS = 1_500

export interface TaskContext {
    requiresTools: boolean
    requiresMemory: boolean
    toolSearchQuery?: string
    memorySearchQueries: string[]
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
}

export async function buildTaskContext(input: BuildTaskContextInput): Promise<TaskContext | null> {
    const currentRequest = input.userQuery?.trim()
    if (!currentRequest || !hasEnabledMode(input.enabledModes)) return null

    const taskId = `auto_router_${nanoid()}`
    emitTaskContextStatus(input.conversationId, taskId, input.eventMeta)

    return runRoutingPhase({
        signal: input.signal,
        label: 'auto-router',
        run: async () => {
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
                            'toolSearchQuery must describe only capabilities required to perform the request, not nouns merely mentioned in it.',
                            'Assess external tools and memory independently. It is valid for neither to be required.',
                            ...enabledRequirementInstructions(input.enabledModes),
                            'Do not include disabled auto modes.',
                            'Do not add execution instructions.',
                            'Do not answer the user. Keep the context specific and omit irrelevant conversation details. /no_think',
                        ].join('\n'),
                    },
                    {
                        role: 'user',
                        content: [
                            `Enabled auto modes: ${enabledModeLabels(input.enabledModes).join(', ')}`,
                            '',
                            recentConversationBlock(input.recentMessages || [], TURN_CHAR_LIMIT),
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
            const parsed = await selectRoutingCandidates({
                conversationId: input.conversationId,
                gateway: input.gateway,
                providerId: input.providerId,
                model: input.model,
                signal: input.signal,
                toolName: TASK_CONTEXT_TOOL_NAME,
                request,
                parse: (raw) => parseTaskContextArguments(raw, input.enabledModes, currentRequest),
            })
            emitTaskContextSelection(input.conversationId, taskId, parsed, input.eventMeta, parsed ? undefined : 'none-generated')
            return parsed
        },
        fallback: () => {
            emitTaskContextSelection(input.conversationId, taskId, null, input.eventMeta, 'routing-failed')
            return null
        },
    })
}

function buildTaskContextTool(enabledModes: BuildTaskContextInput['enabledModes']): ToolDefinition {
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    if (enabledModes.tools) {
        properties.requiresTools = {
            type: 'boolean',
            description: 'False when no external capability is required to answer the request.',
        }
        required.push('requiresTools')
        properties.toolSearchQuery = {
            type: 'string',
            description: 'When tools are required, a compact semantic query optimized for selecting relevant tools and tool namespaces. Omit when requiresTools is false.',
        }
    }
    if (enabledModes.memories) {
        properties.requiresMemory = {
            type: 'boolean',
            description: 'False when stored user or project context is unlikely to help answer the request.',
        }
        required.push('requiresMemory')
        properties.memorySearchQueries = {
            type: 'array',
            description: 'When memory is required, zero to two compact retrieval expansions in the original language. Do not repeat the original request; omit when no useful expansion exists.',
            items: { type: 'string' },
            maxItems: MAX_MEMORY_EXPANSIONS,
        }
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
            toolSearchQuery?: unknown
            memorySearchQueries?: unknown
            requiresTools?: unknown
            requiresMemory?: unknown
        }
        if (enabledModes.tools && typeof parsed.requiresTools !== 'boolean') return null
        if (enabledModes.memories && typeof parsed.requiresMemory !== 'boolean') return null

        const requiresTools = enabledModes.tools && parsed.requiresTools !== false
        const requiresMemory = enabledModes.memories && parsed.requiresMemory !== false
        const toolSearchQuery = requiresTools && typeof parsed.toolSearchQuery === 'string'
            ? parsed.toolSearchQuery.trim().slice(0, MAX_ROUTER_QUERY_LENGTH)
            : ''
        const memorySearchQueries = requiresMemory
            ? normalizeMemoryQueries(Array.isArray(parsed.memorySearchQueries) ? parsed.memorySearchQueries : [], originalRequest)
            : []

        return {
            requiresTools,
            requiresMemory,
            toolSearchQuery: toolSearchQuery || undefined,
            memorySearchQueries,
        }
    } catch {
        return null
    }
}

function normalizeMemoryQueries(values: unknown[], originalRequest: string): string[] {
    return values
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim().slice(0, MAX_ROUTER_QUERY_LENGTH))
        .filter((value) => Boolean(value) && value !== originalRequest.trim())
        .filter((value, index, all) => all.indexOf(value) === index)
        .slice(0, MAX_MEMORY_EXPANSIONS)
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
            ? '- requiresTools: whether external capabilities are needed. If true, optionally provide toolSearchQuery describing the required capabilities, services, filesystems, APIs, or operations.'
            : '',
        modes.memories
            ? '- requiresMemory: whether stored user or project context is likely to help. If true, optionally provide memorySearchQueries with up to two precise alternative searches that complement the unchanged original request.'
            : '',
    ].filter(Boolean)
}

function enabledRequirementInstructions(modes: BuildTaskContextInput['enabledModes']): string[] {
    return [
        modes.tools
            ? 'Set requiresTools=false when the request can be answered without external capabilities.'
            : '',
        modes.memories
            ? 'Set requiresMemory=false when stored user or project context is unlikely to help answer the request.'
            : '',
    ].filter(Boolean)
}

function emitTaskContextStatus(conversationId: string, taskId: string, eventMeta?: Record<string, unknown>): void {
    getEventBus().emit('step:status', {
        conversationId,
        taskId,
        iteration: 0,
        status: 'building-task-context',
        message: 'AI writing retrieval queries',
        ...eventMeta,
    })
}

function emitTaskContextSelection(
    conversationId: string,
    taskId: string,
    context: TaskContext | null,
    eventMeta?: Record<string, unknown>,
    emptyReason?: 'none-generated' | 'routing-failed',
): void {
    emitRoutingDecision({
        conversationId,
        taskId,
        phase: 'task-context',
        eventMeta,
        entries: [{
            name: 'Task context',
            details: stripUndefined({
                type: 'task-context',
                selectionMethod: 'llm',
                requiresTools: context?.requiresTools,
                requiresMemory: context?.requiresMemory,
                toolSearchQuery: context?.toolSearchQuery,
                memorySearchQueries: context?.memorySearchQueries,
                emptyReason,
                content: emptyReason ? taskContextEmptyContent(emptyReason) : undefined,
            }),
        }],
        empty: { name: 'Task context', details: {} },
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
