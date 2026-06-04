/**
 * Shared pre-action builder for agent execution.
 *
 * Consolidates the duplicated pre-action logic (tool resolution, memory
 * space-aware tool hydration, system prompt construction, provider/model resolution) that
 * was previously copy-pasted across chat, cron, channels,
 * and sub-agent triggers.
 */

import { getGateway } from '../gateway/gateway.js'
import { getToolRegistry } from '../tools/tool-registry.js'
import { getBuiltInMemoryToolKeys, hydrateBuiltInTools } from '../tools/built-in-tools.js'
import { applyAutoToolRouting } from './pre-execution/auto-tool-routing.js'
import { applyAutoMemoryRouting } from './pre-execution/auto-memory-routing.js'
import { applyAutoSkillRouting } from './pre-execution/auto-skill-routing.js'
import { resolveProviderAndModel, resolveRouterProviderModel } from './pre-execution/execution-resolvers.js'
import { getSkillsByIds, listSkills } from '../skills/skill-store.js'
import { buildSkillsSystemPrompt } from '../skills/skill-router.js'
import type { SubAgentAssignment } from '../agents/agent-store.js'
import type { ExecutionPreset } from './execution-preset.js'
import type { ChatMessage, RegistryAwareToolDefinition } from '../gateway/providers/base.provider.js'

type BroadcastFn = (event: string, data: unknown) => void

const AGENT_ROUTER_PROVIDER = '__agent_provider__'
const AGENT_ROUTER_MODEL = '__agent_model__'

export interface PrepareExecutionInput {
    /** The resolved agent config */
    preset: ExecutionPreset
    /** Conversation ID for tool hydration and memory aggregation */
    conversationId: string
    /** WebSocket broadcast function */
    broadcast: BroadcastFn

    // ── Overrides ──

    /** Provider override (session-level or trigger-level) */
    providerOverride?: string
    /** Model override (session-level or trigger-level) */
    modelOverride?: string
    /** Replace the agent's system prompt entirely */
    systemPromptOverride?: string
    /** Append extra instructions to the system prompt */
    systemPromptSuffix?: string

    // ── Routing context ──

    /** The user's query text — used for context-aware tool routing */
    userQuery?: string
    /** Recent conversation messages used by context-aware tool routing */
    recentMessages?: ChatMessage[]
    /** Recently invoked tools that should survive routing for this execution turn */
    usedToolNames?: Set<string>
    /** Explicit tool registry keys that should be fixed into the routed tool set */
    preferredToolKeys?: string[]
    /** Enable context-aware MCP tool routing for this execution */
    autoToolRouting?: boolean
    /** Optional provider override for the router confirmation pass */
    toolRouterProviderId?: string
    /** Optional model override for the router confirmation pass */
    toolRouterModel?: string
    /** Enable automatic memory retrieval for this execution. */
    autoMemory?: boolean
    /** Optional provider override for the memory router confirmation pass */
    memoryRouterProviderId?: string
    /** Optional model override for the memory router confirmation pass */
    memoryRouterModel?: string
    /** Explicit/manual skill ids selected for this execution. */
    selectedSkillIds?: string[]
    /** Enable automatic skill selection for this execution. */
    autoSkillRouting?: boolean

    // ── Sub-agents ──

    /** Whether to include sub-agent delegation tools (default: true) */
    includeSubAgents?: boolean
    /** Override agent.subAgents (e.g. when sub-agents come from the request body) */
    subAgentAssignments?: SubAgentAssignment[]
    /** Parent abort signal passed to sub-agent executors */
    signal?: AbortSignal
    /** When false, model/provider overrides are NOT propagated to sub-agents (default: true) */
    overrideSubAgents?: boolean

    // ── Agentless overrides ──

    /** Memory space overrides for agentless chat (bypasses agent's assigned spaces) */
    memorySpaceOverrides?: { id: string; name: string }[]
    /** Agent id used during built-in tool hydration. Defaults to agent.id. */
    hydrationAgentId?: string
    /** Force sub-agent provider override to the resolved execution provider. */
    forceResolvedSubAgentProvider?: boolean
}

export interface PreparedExecution {
    /** Tool definitions ready for the executor */
    tools: RegistryAwareToolDefinition[]
    /** Resolved provider ID */
    providerId: string | undefined
    /** Resolved model name */
    model: string
    /** System messages to prepend to conversation history (order: system prompt, then memory context) */
    systemMessages: ChatMessage[]
    /** Whether sub-agent delegation tools were added */
    hasSubAgents: boolean
}

/**
 * Prepare all shared pre-action state for agent execution.
 *
 * Returns resolved tools (with hydration + sub-agents), provider/model,
 * and system messages (prompt + appended execution context).
 *
 * The caller is responsible for:
 * - Building conversation messages (history or fresh)
 * - Creating the AbortController and AgentExecutor
 * - Post-execution persistence
 */
export async function prepareAgentExecution(input: PrepareExecutionInput): Promise<PreparedExecution> {
    const {
        preset, conversationId, broadcast,
        providerOverride, modelOverride,
        systemPromptOverride, systemPromptSuffix,
        includeSubAgents = true,
        subAgentAssignments,
        signal,
        overrideSubAgents = true,
        memorySpaceOverrides,
        hydrationAgentId,
        forceResolvedSubAgentProvider = false,
    } = input

    const gateway = getGateway()
    const toolRegistry = getToolRegistry()

    // ── 1. Resolve tools ──

    const routingEnabled = isToolRoutingEnabled(preset, input.autoToolRouting)
    const configuredToolKeys = preset.tools || []
    const toolKeys = routingEnabled
        ? toolRegistry.listRegisteredTools().map((tool) => tool.key)
        : configuredToolKeys
    let tools: RegistryAwareToolDefinition[] = toolRegistry.resolveForExecution(toolKeys)
    const preferredToolNames = routingEnabled
        ? toolRegistry
            .resolveForExecution(input.preferredToolKeys ?? [])
            .map((tool) => tool.name)
        : []

    // ── 2. Resolve provider / model ──
    // Must happen before sub-agent tool building so we can pass the resolved
    // provider to sub-agents when a model override is active. Tool routing also
    // uses this provider for its compact confirmation call.

    const providerModel = resolveProviderAndModel({
        gateway,
        baseProviderId: preset.providerId,
        baseModel: preset.model,
        providerOverride,
        modelOverride,
    })

    // ── 2b. Context-aware tool routing ──
    // Sub-agent delegation tools are added later and bypass routing. This pass
    // trims the agent/free-chat tool set before the executor receives schemas.

    if (routingEnabled) {
        const useAgentRouterProvider = preset.toolRouterProviderId === AGENT_ROUTER_PROVIDER
        const useAgentRouterModel = preset.toolRouterModel === AGENT_ROUTER_MODEL

        const router = resolveRouterProviderModel({
            gateway,
            fallbackProviderId: providerModel.providerId,
            fallbackModel: providerModel.model,
            agentRouterProviderId: useAgentRouterProvider ? preset.providerId : (preset.toolRouterProviderId || undefined),
            agentRouterModel: useAgentRouterModel ? (preset.model || undefined) : (preset.toolRouterModel || undefined),
            requestRouterProviderId: input.toolRouterProviderId,
            requestRouterModel: useAgentRouterProvider ? undefined : input.toolRouterModel,
        })

        tools = await applyAutoToolRouting({
            enabled: routingEnabled,
            conversationId,
            userQuery: input.userQuery,
            recentMessages: input.recentMessages,
            tools,
            gateway,
            providerId: router.providerId,
            model: providerModel.model,
            routerModel: router.model,
            mcpMetadata: toolRegistry.getNamespaceMetadataForTools(tools),
            preferredToolNames: preferredToolNames.length ? new Set(preferredToolNames) : undefined,
            usedToolNames: input.usedToolNames,
        })
    }

    // ── 2c. Runtime memory tools ──
    // Memory tools are not manually selectable. When a turn has an explicit
    // memory scope or automatic memory retrieval enabled, provide the read and
    // write memory tools with the same scoped hydration used by selected tools.

    const runtimeMemoryEnabled = isRuntimeMemoryEnabled(preset, input.autoMemory, memorySpaceOverrides)
    if (runtimeMemoryEnabled) {
        const memoryTools = toolRegistry.resolveForExecution(getBuiltInMemoryToolKeys())
        tools = dedupeToolsByName([...tools, ...memoryTools])
    }

    // ── 3. Sub-agent delegation tools ──

    const effectiveSubAgents = includeSubAgents
        ? (subAgentAssignments ?? preset.subAgents)
        : undefined
    const hasSubAgents = Boolean(effectiveSubAgents?.length)

    if (hasSubAgents) {
        const { buildSubAgentTools } = await import('./sub-agent-tools.js')
        const subAgentProviderOverride = overrideSubAgents
            ? (forceResolvedSubAgentProvider || modelOverride
                ? providerModel.providerId
                : (providerOverride || undefined))
            : undefined

        const subAgentTools = buildSubAgentTools({
            subAgents: effectiveSubAgents!,
            conversationId,
            broadcast,
            signal,
            modelOverride: overrideSubAgents ? (modelOverride || undefined) : undefined,
            providerOverride: subAgentProviderOverride,
            toolRouterProviderId: input.toolRouterProviderId,
            toolRouterModel: input.toolRouterModel,
            memoryRouterProviderId: input.memoryRouterProviderId,
            memoryRouterModel: input.memoryRouterModel,
        })
        tools = [...tools, ...subAgentTools]
    }

    // ── 4. Hydrate built-in tool stubs ──

    tools = hydrateBuiltInTools(tools, {
        agentId: hydrationAgentId !== undefined ? hydrationAgentId : preset.id,
        conversationId,
        broadcast,
        memorySpaceOverrides,
    })

    // ── 5. Skills ──

    const manualSkills = getSkillsByIds([
        ...(preset.skills || []),
        ...(input.selectedSkillIds || []),
    ], { enabledOnly: true })

    const selectedSkills = await applyAutoSkillRouting({
        enabled: input.autoSkillRouting === true,
        gateway,
        conversationId,
        userQuery: input.userQuery,
        recentMessages: input.recentMessages,
        manualSkills,
        availableSkills: listSkills({ enabledOnly: true }),
        providerId: providerModel.providerId,
        model: providerModel.model,
    })

    const skillsPrompt = buildSkillsSystemPrompt(selectedSkills)

    // ── 6. System prompt ──

    const systemMessages: ChatMessage[] = []

    let effectiveSystemPrompt = systemPromptOverride ?? preset.systemPrompt ?? ''

    if (hasSubAgents) {
        const { buildSubAgentPrompt } = await import('./sub-agent-tools.js')
        effectiveSystemPrompt = (effectiveSystemPrompt ? effectiveSystemPrompt + '\n' : '') + buildSubAgentPrompt(effectiveSubAgents!)
    }

    if (systemPromptSuffix) {
        effectiveSystemPrompt = (effectiveSystemPrompt ? effectiveSystemPrompt + '\n' : '') + systemPromptSuffix
    }

    if (skillsPrompt) {
        effectiveSystemPrompt = (effectiveSystemPrompt ? effectiveSystemPrompt + '\n\n' : '') + skillsPrompt
    }

    if (effectiveSystemPrompt) {
        // System prompt goes BEFORE memory context (insert at position 0)
        systemMessages.unshift({ role: 'system', content: effectiveSystemPrompt })
    }

    // ── 6. Auto-memory context ──

    if (isAutoMemoryEnabled(preset, input.autoMemory) && !hasExplicitEmptyMemoryScope(memorySpaceOverrides)) {
        const useAgentRouterProvider = preset.memoryRouterProviderId === AGENT_ROUTER_PROVIDER
        const useAgentRouterModel = preset.memoryRouterModel === AGENT_ROUTER_MODEL
        const router = resolveRouterProviderModel({
            gateway,
            fallbackProviderId: providerModel.providerId,
            fallbackModel: providerModel.model,
            agentRouterProviderId: useAgentRouterProvider ? preset.providerId : (preset.memoryRouterProviderId || undefined),
            agentRouterModel: useAgentRouterModel ? (preset.model || undefined) : (preset.memoryRouterModel || undefined),
            requestRouterProviderId: input.memoryRouterProviderId,
            requestRouterModel: useAgentRouterProvider ? undefined : input.memoryRouterModel,
        })

        const memoryContext = await applyAutoMemoryRouting({
            enabled: true,
            conversationId,
            userQuery: input.userQuery,
            recentMessages: input.recentMessages,
            gateway,
            providerId: router.providerId,
            model: providerModel.model,
            routerModel: router.model,
            agentId: preset.id === '__agentless__' ? undefined : preset.id,
            memorySpaceIds: memorySpaceOverrides?.map((space) => space.id),
        })

        if (memoryContext) {
            systemMessages.push({ role: 'system', content: memoryContext })
        }
    }

    return {
        tools,
        providerId: providerModel.providerId,
        model: providerModel.model,
        systemMessages,
        hasSubAgents,
    }
}

function isAutoMemoryEnabled(preset: ExecutionPreset, sessionEnabled?: boolean): boolean {
    if (sessionEnabled === true) return true
    if (sessionEnabled === false) return false
    return preset.autoMemory === true
}

function isRuntimeMemoryEnabled(
    preset: ExecutionPreset,
    sessionEnabled: boolean | undefined,
    memorySpaceOverrides: { id: string; name: string }[] | undefined,
): boolean {
    if (hasExplicitEmptyMemoryScope(memorySpaceOverrides)) return false
    return Boolean(memorySpaceOverrides?.length) || isAutoMemoryEnabled(preset, sessionEnabled)
}

function hasExplicitEmptyMemoryScope(
    memorySpaceOverrides: { id: string; name: string }[] | undefined,
): boolean {
    return Array.isArray(memorySpaceOverrides) && memorySpaceOverrides.length === 0
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
