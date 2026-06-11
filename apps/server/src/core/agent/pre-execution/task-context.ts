import { nanoid } from 'nanoid'
import { getEventBus } from '../../telemetry/event-bus.js'
import type { LLMGateway } from '../../gateway/gateway.js'
import type { ChatMessage, ContentPart, ToolDefinition } from '../../gateway/providers/base.provider.js'

const TASK_CONTEXT_TOOL_NAME = 'set_task_context'
const TURN_CHAR_LIMIT = 500
const MAX_ROUTER_QUERY_LENGTH = 2_000
const MAX_SYSTEM_CONTEXT_LENGTH = 2_500

export interface TaskContext {
    routerQuery: string
    systemContext: string
    focusAreas: string[]
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
        skills: boolean
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
                        'You prepare a compact task context before the main assistant run.',
                        'Given the current request and recent conversation, call set_task_context with:',
                        '- routerQuery: the best retrieval/routing query for automatic tools, skills, and memories.',
                        '- systemContext: concise facts, constraints, and intent the main assistant should start with.',
                        '- focusAreas: short labels for the information or capabilities likely needed.',
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
            tools: [buildTaskContextTool()],
            toolChoice: { type: 'function', name: TASK_CONTEXT_TOOL_NAME },
            thinkingEnabled: false,
        }, input.providerId)

        const contextCall = result.toolCalls?.find((call) => call.function.name === TASK_CONTEXT_TOOL_NAME)
        const parsed = contextCall ? parseTaskContextArguments(contextCall.function.arguments) : null
        const context = parsed || fallbackTaskContext(currentRequest, input.recentMessages || [])
        emitTaskContextSelection(input.conversationId, taskId, context, input.eventMeta)
        return context
    } catch (err) {
        console.warn('[auto-router] Task context build failed, using local fallback:', err)
        const context = fallbackTaskContext(currentRequest, input.recentMessages || [])
        emitTaskContextSelection(input.conversationId, taskId, context, input.eventMeta)
        return context
    }
}

export function appendTaskContextSystemMessage(messages: ChatMessage[], taskContext: TaskContext | null): ChatMessage[] {
    if (!taskContext?.systemContext.trim()) return messages
    return [
        ...messages,
        {
            role: 'system',
            content: [
                'Task context prepared before execution:',
                taskContext.systemContext.trim(),
                taskContext.focusAreas.length ? `Likely relevant focus: ${taskContext.focusAreas.join(', ')}` : '',
            ].filter(Boolean).join('\n'),
        },
    ]
}

function buildTaskContextTool(): ToolDefinition {
    return {
        name: TASK_CONTEXT_TOOL_NAME,
        description: 'Set the compact task context used to route automatic capabilities and start the main execution.',
        timeout: 1_000,
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                routerQuery: {
                    type: 'string',
                    description: 'A compact query for selecting relevant auto tools, skills, and memories.',
                },
                systemContext: {
                    type: 'string',
                    description: 'Concise task facts and constraints to include in the main execution context.',
                },
                focusAreas: {
                    type: 'array',
                    description: 'Short labels for information or capabilities likely needed.',
                    items: { type: 'string' },
                },
            },
            required: ['routerQuery', 'systemContext', 'focusAreas'],
        },
        execute: async () => ({ success: true, output: 'ok' }),
    }
}

function parseTaskContextArguments(raw: string): TaskContext | null {
    try {
        const parsed = JSON.parse(raw) as {
            routerQuery?: unknown
            systemContext?: unknown
            focusAreas?: unknown
        }
        const routerQuery = typeof parsed.routerQuery === 'string' ? parsed.routerQuery.trim() : ''
        const systemContext = typeof parsed.systemContext === 'string' ? parsed.systemContext.trim() : ''
        const focusAreas = Array.isArray(parsed.focusAreas)
            ? parsed.focusAreas.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
            : []

        if (!routerQuery && !systemContext) return null
        return {
            routerQuery: (routerQuery || systemContext).slice(0, MAX_ROUTER_QUERY_LENGTH),
            systemContext: (systemContext || routerQuery).slice(0, MAX_SYSTEM_CONTEXT_LENGTH),
            focusAreas: [...new Set(focusAreas)].slice(0, 8),
        }
    } catch {
        return null
    }
}

function fallbackTaskContext(currentRequest: string, messages: ChatMessage[]): TaskContext {
    const recent = buildRecentConversationBlock(messages)
    const routerQuery = [
        recent,
        `Current request: ${currentRequest}`,
    ].filter(Boolean).join('\n\n')

    return {
        routerQuery: routerQuery.slice(0, MAX_ROUTER_QUERY_LENGTH),
        systemContext: currentRequest.slice(0, MAX_SYSTEM_CONTEXT_LENGTH),
        focusAreas: [],
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
    return modes.tools || modes.skills || modes.memories
}

function enabledModeLabels(modes: BuildTaskContextInput['enabledModes']): string[] {
    return [
        modes.tools ? 'tools' : '',
        modes.skills ? 'skills' : '',
        modes.memories ? 'memories' : '',
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

function emitTaskContextSelection(conversationId: string, taskId: string, context: TaskContext, eventMeta?: Record<string, unknown>): void {
    getEventBus().emit('step:tools-chosen', {
        conversationId,
        taskId,
        iteration: 0,
        ...eventMeta,
        toolCalls: [{
            name: 'Task context',
            arguments: JSON.stringify({
                type: 'auto-router',
                focusAreas: context.focusAreas,
                routerQuery: context.routerQuery,
            }),
        }],
    })
}
