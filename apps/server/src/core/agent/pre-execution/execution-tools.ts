import { getBuiltInMemoryToolKeys, getBuiltInToolKey, hydrateBuiltInTools, makeSearchAvailableMcpToolsTool } from '../../tools/built-in-tools.js'
import { applyAutoToolRouting } from './auto-tool-routing.js'
import { recordLoadedTools, stabilizeRoutedTools } from './conversation-toolset.js'
import { isRuntimeMemoryEnabled } from './execution-memory.js'
import type { ExecutionPreset } from '../execution-preset.js'
import type { PrepareExecutionInput } from '../prepare-execution.js'
import type { SubAgentAssignment } from '../../agents/agent-store.js'
import type { LLMGateway } from '../../gateway/gateway.js'
import type { RegistryAwareToolDefinition } from '../../gateway/providers/base.provider.js'
import type { ToolRegistry } from '../../tools/tool-registry.js'
import type { ConversationExecutionConfig } from '@shared/types'
import { MANAGE_MCP_TOOL_NAME } from '../../tools/builtin/manage-mcp.js'
import { TOOL_SEARCH_TOOL_NAME } from '../../tools/builtin/expand-available-toolset.js'

export type ResolveExecutionToolsInput = Pick<PrepareExecutionInput,
    | 'preset' | 'conversationId' | 'broadcast' | 'userQuery' | 'recentMessages' | 'usedToolNames'
    | 'preferredToolKeys' | 'routingToolKeys' | 'autoToolRouting' | 'autoMemory' | 'includeSubAgents'
    | 'subAgentAssignments' | 'signal' | 'memoryFolderOverrides' | 'hydrationAgentId' | 'eventMeta'> & {
    toolRegistry: ToolRegistry
    gateway: LLMGateway
    /** Router provider and model used for toolset selection. */
    resolvedProviderId: string
    resolvedModel: string
    /** Skip routing when task-context planning says no tool is needed; pinned tools and tool search remain. */
    suppressAutoTools?: boolean
    /** Snapshot used when an agentless scheduling tool creates a durable job. */
    scheduleExecutionConfig?: ConversationExecutionConfig
    /** Toolsets already chosen by task-context planning. */
    plannedToolsetIds?: string[]
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
        routingToolKeys,
        autoToolRouting,
        autoMemory,
        includeSubAgents = true,
        subAgentAssignments,
        signal,
        memoryFolderOverrides,
        hydrationAgentId,
        eventMeta,
        suppressAutoTools = false,
        scheduleExecutionConfig,
        plannedToolsetIds,
    } = input

    const autoRoutingEnabled = isToolRoutingEnabled(preset, autoToolRouting)
    const candidateTools = autoRoutingEnabled
        ? resolveRoutingCandidateTools({ preset, toolRegistry, preferredToolKeys, routingToolKeys })
        : toolRegistry.resolveForExecution(preset.tools || [])
    let tools: RegistryAwareToolDefinition[]
    if (!autoRoutingEnabled) {
        tools = candidateTools
    } else if (suppressAutoTools) {
        // Task-context planning judged that no tools are needed. Keep the pinned
        // tools plus the discovery tool so a wrong judgement stays recoverable.
        const fixedTools = toolRegistry.resolveForExecution(preferredToolKeys ?? [])
        const searchTool = makeSearchAvailableMcpToolsTool({
            allTools: candidateTools,
            mcpMetadata: toolRegistry.getNamespaceMetadataForTools(candidateTools),
            getLoadedToolNames: () => new Set(fixedTools.map((tool) => tool.name)),
        })
        const stickyKey = stickyToolsetKey(conversationId, preset)
        tools = stabilizeRoutedTools(stickyKey, [...fixedTools, searchTool as RegistryAwareToolDefinition], candidateTools)
        tools = withRecordedToolSearch(stickyKey, tools, candidateTools, toolRegistry)
    } else {
        const preferredToolNames = toolRegistry.resolveForExecution(preferredToolKeys ?? []).map((tool) => tool.name)
        const routedTools = await applyAutoToolRouting({
            enabled: true,
            conversationId,
            userQuery,
            recentMessages,
            gateway,
            providerId: resolvedProviderId,
            model: resolvedModel,
            tools: candidateTools,
            mcpMetadata: toolRegistry.getNamespaceMetadataForTools(candidateTools),
            preferredToolNames: preferredToolNames.length ? new Set(preferredToolNames) : undefined,
            usedToolNames,
            plannedToolsetIds,
            eventMeta,
            signal,
        }) as RegistryAwareToolDefinition[]
        const stickyKey = stickyToolsetKey(conversationId, preset)
        tools = stabilizeRoutedTools(stickyKey, routedTools, candidateTools)
        tools = withRecordedToolSearch(stickyKey, tools, candidateTools, toolRegistry)
    }

    if (isRuntimeMemoryEnabled(preset, autoMemory, memoryFolderOverrides)) {
        const memoryTools = toolRegistry.resolveForExecution(getBuiltInMemoryToolKeys())
        tools = dedupeToolsByName([...memoryTools, ...tools])
    }

    const effectiveSubAgents = includeSubAgents
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
        memoryFolderOverrides,
        scheduleExecutionConfig,
    })
    return {
        tools,
        hasSubAgents,
        effectiveSubAgents,
    }
}

/** The catalogue automatic tool routing chooses from. manage_mcp stays out unless explicitly selected. */
export function resolveRoutingCandidateTools(input: {
    preset: ExecutionPreset
    toolRegistry: ToolRegistry
    preferredToolKeys?: string[]
    routingToolKeys?: string[]
}): RegistryAwareToolDefinition[] {
    const { preset, toolRegistry, preferredToolKeys, routingToolKeys } = input
    const manageMcpToolKey = getBuiltInToolKey(MANAGE_MCP_TOOL_NAME)
    const manageMcpEnabled = (preset.tools || []).includes(manageMcpToolKey)
        || preferredToolKeys?.includes(manageMcpToolKey) === true
    const toolKeys = (routingToolKeys ?? toolRegistry.listRegisteredTools().map((tool) => tool.key))
        .filter((key) => key !== manageMcpToolKey || manageMcpEnabled)
    return toolRegistry.resolveForExecution(toolKeys)
}

/**
 * Rebuild tool search against the stabilized list, so it skips every tool
 * already offered, and record what it loads into the conversation's toolset.
 */
function withRecordedToolSearch(
    stickyKey: string,
    tools: RegistryAwareToolDefinition[],
    candidateTools: RegistryAwareToolDefinition[],
    toolRegistry: ToolRegistry,
): RegistryAwareToolDefinition[] {
    const index = tools.findIndex((tool) => tool.name === TOOL_SEARCH_TOOL_NAME)
    if (index === -1) return tools
    const search = makeSearchAvailableMcpToolsTool({
        allTools: candidateTools,
        mcpMetadata: toolRegistry.getNamespaceMetadataForTools(candidateTools),
        getLoadedToolNames: () => new Set(tools.map((tool) => tool.name)),
    })
    const recording: RegistryAwareToolDefinition = {
        ...search,
        execute: async (params, signal) => {
            const result = await search.execute(params, signal)
            if (!result.loadedTools?.length) return result
            return { ...result, loadedToolsAfter: recordLoadedTools(stickyKey, result.loadedTools.map((tool) => tool.name)) }
        },
    }
    return tools.map((tool, toolIndex) => toolIndex === index ? recording : tool)
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

/** Sub-agents share the conversation id but route their own tool lists. */
function stickyToolsetKey(conversationId: string, preset: ExecutionPreset): string {
    return `${conversationId}\u0000${preset.id}`
}

export function isToolRoutingEnabled(preset: ExecutionPreset, sessionEnabled?: boolean): boolean {
    return sessionEnabled ?? preset.autoToolRouting === true
}
