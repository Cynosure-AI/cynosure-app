import { nanoid } from 'nanoid'
import { getEventBus } from '../../telemetry/event-bus.js'
import { TOOL_SEARCH_TOOL_NAME } from '../../tools/builtin/expand-available-toolset.js'
import { routeTools, shouldRouteTools } from './../tool-router.js'
import type { ChatMessage, RegistryAwareToolDefinition, ToolDefinition } from '../../gateway/providers/base.provider.js'
import type { ToolNamespaceMetadata } from '../../tools/tool-registry.js'

export interface ApplyAutoToolRoutingInput {
    enabled: boolean
    conversationId: string
    userQuery?: string
    recentMessages?: ChatMessage[]
    tools: RegistryAwareToolDefinition[]
    mcpMetadata?: ToolNamespaceMetadata[]
    /** Explicitly selected tool names that must be included after routing. */
    preferredToolNames?: Set<string>
    usedToolNames?: Set<string>
    /** Extra metadata to merge into emitted EventBus events (e.g. maCodename for sub-agents). */
    eventMeta?: Record<string, unknown>
}

export async function applyAutoToolRouting(input: ApplyAutoToolRoutingInput): Promise<ToolDefinition[]> {
    const {
        enabled,
        conversationId,
        userQuery,
        recentMessages,
        tools,
        mcpMetadata,
        preferredToolNames,
        usedToolNames,
        eventMeta,
    } = input

    if (!shouldRouteTools(tools, userQuery, { enabled })) {
        return tools
    }

    const taskId = `router_${nanoid()}`
    try {
        emitToolRoutingStatus(conversationId, taskId, 'routing-tools', 'Selecting relevant tools...', eventMeta)
        const routedTools = await routeTools({
            userQuery: userQuery || '',
            recentMessages: recentMessages || [],
            allTools: tools,
            mcpMetadata,
            preferredToolNames,
            usedToolNames,
        })
        emitToolRoutingSelection(conversationId, taskId, routedTools, eventMeta)
        return routedTools
    } catch (err) {
        console.warn('[tool-router] Routing failed, using local tool list:', err)
        const fallbackTools = tools.filter((tool) => !tool.namespaceId?.startsWith('mcp:'))
        emitToolRoutingSelection(conversationId, taskId, fallbackTools, eventMeta)
        return fallbackTools
    }
}

function emitToolRoutingStatus(conversationId: string, taskId: string, status: string, message: string, eventMeta?: Record<string, unknown>): void {
    getEventBus().emit('step:status', {
        conversationId,
        taskId,
        iteration: 0,
        status,
        message,
        ...eventMeta,
    })
}

function emitToolRoutingSelection(conversationId: string, taskId: string, tools: ToolDefinition[], eventMeta?: Record<string, unknown>): void {
    getEventBus().emit('step:tools-chosen', {
        conversationId,
        taskId,
        iteration: 0,
        ...eventMeta,
        toolCalls: tools
            .filter((tool) => tool.name !== TOOL_SEARCH_TOOL_NAME)
            .map((tool) => ({ name: tool.name, arguments: '{}' })),
    })
}
