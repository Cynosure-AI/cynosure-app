import { getBuiltInMemoryReadToolKeys, getBuiltInMemoryToolKeys, hydrateBuiltInTools } from '../../tools/built-in-tools.js'
import { applyAutoToolRouting, emitAutoToolRoutingSkipped } from './auto-tool-routing.js'
import { isRuntimeMemoryEnabled, type ExecutionMemoryCategoryRef } from './execution-memory.js'
import type { ExecutionPreset } from '../execution-preset.js'
import type { SubAgentAssignment } from '../../agents/agent-store.js'
import type { LLMGateway } from '../../gateway/gateway.js'
import type { ChatMessage, RegistryAwareToolDefinition } from '../../gateway/providers/base.provider.js'
import type { ToolRegistry } from '../../tools/tool-registry.js'
import type { RequestedToolEffect } from './task-context.js'
import type { ConversationExecutionConfig } from '@shared/types'
import { makeManageMcpTool } from '../../tools/builtin/manage-mcp.js'

type BroadcastFn = (event: string, data: unknown) => void

export interface ResolveExecutionToolsInput {
    preset: ExecutionPreset
    conversationId: string
    broadcast: BroadcastFn
    toolRegistry: ToolRegistry
    gateway: LLMGateway
    resolvedProviderId: string
    resolvedModel: string
    userQuery?: string
    recentMessages?: ChatMessage[]
    usedToolNames?: Set<string>
    preferredToolKeys?: string[]
    autoToolRouting?: boolean
    autoMemory?: boolean
    includeSubAgents?: boolean
    subAgentAssignments?: SubAgentAssignment[]
    signal?: AbortSignal
    memoryCategoryOverrides?: ExecutionMemoryCategoryRef[]
    hydrationAgentId?: string
    /** Extra metadata to merge into emitted EventBus events during pre-execution routing. */
    eventMeta?: Record<string, unknown>
    requestedToolEffect?: RequestedToolEffect
    /** Bypass the external catalogue for deterministic memory-only fast paths. */
    suppressAutoTools?: boolean
    debugContextEnabled?: boolean
    /** Snapshot used when an agentless scheduling tool creates a durable job. */
    scheduleExecutionConfig?: ConversationExecutionConfig
}

export interface ResolvedExecutionTools {
    tools: RegistryAwareToolDefinition[]
    hasSubAgents: boolean
    effectiveSubAgents: SubAgentAssignment[]
}

export async function resolveExecutionTools(input: ResolveExecutionToolsInput): Promise<ResolvedExecutionTools> {
    const {
        preset,
        conversationId,
        broadcast,
        toolRegistry,
        gateway,
        resolvedProviderId,
        resolvedModel,
        userQuery,
        recentMessages,
        usedToolNames,
        preferredToolKeys,
        autoToolRouting,
        autoMemory,
        includeSubAgents = true,
        subAgentAssignments,
        signal,
        memoryCategoryOverrides,
        hydrationAgentId,
        eventMeta,
        requestedToolEffect = 'read',
        suppressAutoTools = false,
        debugContextEnabled,
        scheduleExecutionConfig,
    } = input

    const routingEnabled = !suppressAutoTools && isToolRoutingEnabled(preset, autoToolRouting)
    const configuredToolKeys = preset.tools || []
    const toolKeys = routingEnabled
        ? toolRegistry.listRegisteredTools().map((tool) => tool.key)
        : configuredToolKeys

    let tools: RegistryAwareToolDefinition[] = suppressAutoTools
        ? filterToolsForExecutionPreset(preset, toolRegistry.resolveForExecution(preferredToolKeys ?? []))
        : filterToolsForExecutionPreset(preset, toolRegistry.resolveForExecution(toolKeys))
    const preferredToolNames = routingEnabled
        ? filterToolsForExecutionPreset(preset, toolRegistry.resolveForExecution(preferredToolKeys ?? []))
            .map((tool) => tool.name)
        : []

    if (routingEnabled) {
        tools = await applyAutoToolRouting({
            enabled: routingEnabled,
            conversationId,
            userQuery,
            recentMessages,
            gateway,
            providerId: resolvedProviderId,
            model: resolvedModel,
            tools,
            mcpMetadata: toolRegistry.getNamespaceMetadataForTools(tools),
            preferredToolNames: preferredToolNames.length ? new Set(preferredToolNames) : undefined,
            usedToolNames,
            eventMeta,
            signal,
            debugContextEnabled,
        }) as RegistryAwareToolDefinition[]
    } else {
        emitAutoToolRoutingSkipped(conversationId, 'disabled', eventMeta)
    }

    if (isRuntimeMemoryEnabled(preset, autoMemory, memoryCategoryOverrides)) {
        const memoryToolKeys = requestedToolEffect === 'read'
            ? getBuiltInMemoryReadToolKeys()
            : getBuiltInMemoryToolKeys()
        const memoryTools = toolRegistry.resolveForExecution(memoryToolKeys)
        tools = dedupeToolsByName([...memoryTools, ...tools])
    }

    const effectiveSubAgents = includeSubAgents && !suppressAutoTools
        ? (subAgentAssignments ?? preset.subAgents)
        : []
    const hasSubAgents = effectiveSubAgents.length > 0

    if (hasSubAgents) {
        const { buildSubAgentTools } = await import('../sub-agent-tools.js')

        tools = [
            ...tools,
            ...buildSubAgentTools({
                subAgents: effectiveSubAgents,
                conversationId,
                broadcast,
                signal,
                eventMeta,
            }),
        ]
    }

    tools = hydrateBuiltInTools(tools, {
        agentId: hydrationAgentId !== undefined ? hydrationAgentId : preset.id,
        conversationId,
        broadcast,
        memoryCategoryOverrides,
        scheduleExecutionConfig,
    })
    // MCP configuration is an application-level capability, so it remains
    // available even when the user has not selected any external tool yet.
    tools = dedupeToolsByName([...tools, makeManageMcpTool()])

    return {
        tools,
        hasSubAgents,
        effectiveSubAgents,
    }
}

export function filterToolsForExecutionPreset<T extends Pick<RegistryAwareToolDefinition, 'name' | 'originalName' | 'namespaceId'>>(
    _preset: ExecutionPreset,
    tools: T[],
): T[] {
    return tools
}

function dedupeToolsByName(tools: RegistryAwareToolDefinition[]): RegistryAwareToolDefinition[] {
    const seen = new Set<string>()
    const result: RegistryAwareToolDefinition[] = []
    for (const tool of tools) {
        if (seen.has(tool.name)) continue
        seen.add(tool.name)
        result.push(tool)
    }
    return result
}

export function isToolRoutingEnabled(preset: ExecutionPreset, sessionEnabled?: boolean): boolean {
    if (preset.disableToolRouting === true) return false
    if (preset.toolRoutingEnabled === false) return false
    if (sessionEnabled === true) return true
    if (sessionEnabled === false) return false
    return preset.autoToolRouting === true || preset.toolRoutingEnabled === true
}
