import { BUILTIN_NAMESPACE_ID, getBuiltInMemoryReadToolKeys, getBuiltInMemoryToolKeys, hydrateBuiltInTools } from '../../tools/built-in-tools.js'
import { applyAutoToolRouting, emitAutoToolRoutingSkipped } from './auto-tool-routing.js'
import { isRuntimeMemoryEnabled, type ExecutionMemorySpaceRef } from './execution-memory.js'
import type { ExecutionPreset } from '../execution-preset.js'
import type { SubAgentAssignment } from '../../agents/agent-store.js'
import type { LLMGateway } from '../../gateway/gateway.js'
import type { ChatMessage, RegistryAwareToolDefinition } from '../../gateway/providers/base.provider.js'
import type { ToolRegistry } from '../../tools/tool-registry.js'
import { isScheduleToolName } from '../../tools/builtin/schedule-tools.js'
import type { RequestedToolEffect } from './task-context.js'

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
    memorySpaceOverrides?: ExecutionMemorySpaceRef[]
    hydrationAgentId?: string
    /** Extra metadata to merge into emitted EventBus events during pre-execution routing. */
    eventMeta?: Record<string, unknown>
    requestedToolEffect?: RequestedToolEffect
    /** Bypass the external catalogue for deterministic memory-only fast paths. */
    suppressAutoTools?: boolean
    debugContextEnabled?: boolean
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
        memorySpaceOverrides,
        hydrationAgentId,
        eventMeta,
        requestedToolEffect = 'read',
        suppressAutoTools = false,
        debugContextEnabled,
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
            requestedToolEffect,
            debugContextEnabled,
        }) as RegistryAwareToolDefinition[]
    } else {
        emitAutoToolRoutingSkipped(conversationId, 'disabled', eventMeta)
    }

    if (isRuntimeMemoryEnabled(preset, autoMemory, memorySpaceOverrides)) {
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
        memorySpaceOverrides,
    })

    return {
        tools,
        hasSubAgents,
        effectiveSubAgents,
    }
}

/** Agentless conversations cannot own durable schedules. */
export function filterToolsForExecutionPreset<T extends Pick<RegistryAwareToolDefinition, 'name' | 'originalName' | 'namespaceId'>>(
    preset: ExecutionPreset,
    tools: T[],
): T[] {
    if (preset.id !== '__agentless__') return tools
    return tools.filter((tool) => (
        tool.namespaceId !== BUILTIN_NAMESPACE_ID || !isScheduleToolName(tool.originalName ?? tool.name)
    ))
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

function isToolRoutingEnabled(preset: ExecutionPreset, sessionEnabled?: boolean): boolean {
    if (preset.disableToolRouting === true) return false
    if (preset.toolRoutingEnabled === false) return false
    if (sessionEnabled === true) return true
    if (sessionEnabled === false) return false
    return preset.autoToolRouting === true || preset.toolRoutingEnabled === true
}
