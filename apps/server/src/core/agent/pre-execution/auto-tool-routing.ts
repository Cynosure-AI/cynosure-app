import { nanoid } from 'nanoid'
import { getEventBus } from '../../telemetry/event-bus.js'
import { TOOL_SEARCH_TOOL_NAME } from '../../tools/builtin/expand-available-toolset.js'
import { routeTools, shouldRouteTools } from './../tool-router.js'
import type { LLMGateway } from '../../gateway/gateway.js'
import type { ChatMessage, RegistryAwareToolDefinition, ToolDefinition } from '../../gateway/providers/base.provider.js'
import type { ToolNamespaceMetadata } from '../../tools/tool-registry.js'

export interface ApplyAutoToolRoutingInput {
    enabled: boolean
    conversationId: string
    userQuery?: string
    recentMessages?: ChatMessage[]
    tools: RegistryAwareToolDefinition[]
    gateway: LLMGateway
    providerId: string
    model: string
    routerModel?: string
    mcpMetadata?: ToolNamespaceMetadata[]
    /** Explicitly selected tool names that must be included after routing. */
    preferredToolNames?: Set<string>
    usedToolNames?: Set<string>
}

export async function applyAutoToolRouting(input: ApplyAutoToolRoutingInput): Promise<ToolDefinition[]> {
    const {
        enabled,
        conversationId,
        userQuery,
        recentMessages,
        tools,
        gateway,
        providerId,
        model,
        routerModel,
        mcpMetadata,
        preferredToolNames,
        usedToolNames,
    } = input

    if (!shouldRouteTools(tools, userQuery, { enabled })) {
        return tools
    }

    const taskId = `router_${nanoid()}`
    try {
        emitToolRoutingStatus(conversationId, taskId, 'routing-tools', 'Selecting relevant tools...')
        const routedTools = await routeTools({
            userQuery: userQuery || '',
            recentMessages: recentMessages || [],
            allTools: tools,
            gateway,
            providerId,
            model,
            routerModel,
            mcpMetadata,
            preferredToolNames,
            usedToolNames,
        })
        emitToolRoutingSelection(conversationId, taskId, routedTools)
        return routedTools
    } catch (err) {
        console.warn('[tool-router] Routing failed, using local tool list:', err)
        const fallbackTools = tools.filter((tool) => !tool.namespaceId?.startsWith('mcp:'))
        emitToolRoutingSelection(conversationId, taskId, fallbackTools)
        return fallbackTools
    }
}

function emitToolRoutingStatus(conversationId: string, taskId: string, status: string, message: string): void {
    getEventBus().emit('step:status', {
        conversationId,
        taskId,
        iteration: 0,
        status,
        message,
    })
}

function emitToolRoutingSelection(conversationId: string, taskId: string, tools: ToolDefinition[]): void {
    getEventBus().emit('step:tools-chosen', {
        conversationId,
        taskId,
        iteration: 0,
        toolCalls: tools
            .filter((tool) => tool.name !== TOOL_SEARCH_TOOL_NAME)
            .map((tool) => ({ name: tool.name, arguments: '{}' })),
    })
}
