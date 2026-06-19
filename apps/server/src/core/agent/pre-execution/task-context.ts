import { nanoid } from 'nanoid'
import { getEventBus } from '../../telemetry/event-bus.js'
import type { LLMGateway } from '../../gateway/gateway.js'
import type { ChatMessage, ContentPart, ToolDefinition } from '../../gateway/providers/base.provider.js'

const TASK_CONTEXT_TOOL_NAME = 'set_task_context'
const TURN_CHAR_LIMIT = 500
const MAX_ROUTER_QUERY_LENGTH = 2_000

export interface TaskContext {
    toolQuery?: string
    memoryQuery?: string
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
}

export async function buildTaskContext(input: BuildTaskContextInput): Promise<TaskContext | null> {
    const currentRequest = input.userQuery?.trim()
    if (!currentRequest || !hasEnabledMode(input.enabledModes)) return null

    const taskId = `auto_router_${nanoid()}`
    emitTaskContextStatus(input.conversationId, taskId, input.eventMeta)

    try {
        const result = await input.gateway.complete({
            messages: [
                {
                    role: 'system',
                    content: [
                        'You prepare routing queries before the main assistant run.',
                        'Given the current request and recent conversation, call set_task_context with one query for each enabled auto mode.',
                        ...enabledQueryInstructions(input.enabledModes),
                        'Each query must be specific to what that subsystem needs to retrieve or select.',
                        'Do not copy the user request verbatim unless it is already the best possible retrieval query.',
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
            maxTokens: 700,
            tools: [buildTaskContextTool(input.enabledModes)],
            toolChoice: { type: 'function', name: TASK_CONTEXT_TOOL_NAME },
            thinkingEnabled: false,
        }, input.providerId)

        const contextCall = result.toolCalls?.find((call) => call.function.name === TASK_CONTEXT_TOOL_NAME)
        const parsed = contextCall ? parseTaskContextArguments(contextCall.function.arguments, input.enabledModes) : null
        emitTaskContextSelection(input.conversationId, taskId, parsed, input.eventMeta)
        return parsed
    } catch (err) {
        console.warn('[auto-router] Task context build failed, using original request in downstream routers:', err)
        emitTaskContextSelection(input.conversationId, taskId, null, input.eventMeta)
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
    }
    if (enabledModes.memories) {
        properties.memoryQuery = {
            type: 'string',
            description: 'A compact semantic query optimized for memory retrieval.',
        }
        required.push('memoryQuery')
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

function parseTaskContextArguments(raw: string, enabledModes: BuildTaskContextInput['enabledModes']): TaskContext | null {
    try {
        const parsed = JSON.parse(raw) as { toolQuery?: unknown; memoryQuery?: unknown }
        const toolQuery = enabledModes.tools && typeof parsed.toolQuery === 'string' ? parsed.toolQuery.trim() : ''
        const memoryQuery = enabledModes.memories && typeof parsed.memoryQuery === 'string' ? parsed.memoryQuery.trim() : ''

        if (enabledModes.tools && !toolQuery) return null
        if (enabledModes.memories && !memoryQuery) return null
        return {
            toolQuery: toolQuery ? toolQuery.slice(0, MAX_ROUTER_QUERY_LENGTH) : undefined,
            memoryQuery: memoryQuery ? memoryQuery.slice(0, MAX_ROUTER_QUERY_LENGTH) : undefined,
        }
    } catch {
        return null
    }
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
            ? '- memoryQuery: what remembered knowledge, entities, locations, user preferences, prior project facts, documents, or account-specific context should be retrieved.'
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

function emitTaskContextSelection(conversationId: string, taskId: string, context: TaskContext | null, eventMeta?: Record<string, unknown>): void {
    getEventBus().emit('step:tools-chosen', {
        conversationId,
        taskId,
        iteration: 0,
        ...eventMeta,
        toolCalls: context ? [{
            name: 'Task context',
            arguments: JSON.stringify(stripUndefined({
                type: 'task-context',
                toolQuery: context.toolQuery,
                memoryQuery: context.memoryQuery,
            })),
        }] : [],
    })
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}
