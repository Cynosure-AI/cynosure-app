/**
 * Shared pre-action builder for agent execution.
 *
 * Consolidates the duplicated pre-action logic (tool resolution, memory
 * enrichment, system prompt construction, provider/model resolution) that
 * was previously copy-pasted across chat, cron, file-watcher, channels,
 * and sub-agent triggers.
 */

import { getGateway } from '../gateway/gateway.js'
import { getToolRegistry } from '../tools/tool-registry.js'
import { hydrateBuiltInTools } from '../tools/built-in-tools.js'
import { routeTools, shouldRouteTools } from './tool-router.js'
import { getEventBus } from '../telemetry/event-bus.js'
import { nanoid } from 'nanoid'
import type { AgentData, SubAgentAssignment } from '../agents/agent-store.js'
import type { ChatMessage, ToolDefinition } from '../gateway/providers/base.provider.js'

type BroadcastFn = (event: string, data: unknown) => void

export interface PrepareExecutionInput {
    /** The resolved agent config */
    agent: AgentData
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

    // ── Memory enrichment ──

    /** The user's query text — used as the memory retrieval query */
    userQuery?: string
    /** Recent conversation messages used by context-aware tool routing */
    recentMessages?: ChatMessage[]
    /** Whether this is the first user message (memory enrichment only triggers on first message) */
    isFirstMessage?: boolean
    /** Recently invoked tools that should survive routing for this execution turn */
    usedToolNames?: Set<string>
    /** Enable context-aware MCP tool routing for this execution */
    autoToolRouting?: boolean
    /** Optional provider override for the router confirmation pass */
    toolRouterProviderId?: string
    /** Optional model override for the router confirmation pass */
    toolRouterModel?: string

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
}

export interface PreparedExecution {
    /** Tool definitions ready for the executor */
    tools: ToolDefinition[]
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
 * system messages (prompt + memory context), and memory sources.
 *
 * The caller is responsible for:
 * - Building conversation messages (history or fresh)
 * - Creating the AbortController and AgentExecutor
 * - Post-execution persistence
 */
export async function prepareAgentExecution(input: PrepareExecutionInput): Promise<PreparedExecution> {
    const {
        agent, conversationId, broadcast,
        providerOverride, modelOverride,
        systemPromptOverride, systemPromptSuffix,
        includeSubAgents = true,
        subAgentAssignments,
        signal,
        overrideSubAgents = true,
        memorySpaceOverrides,
    } = input

    const gateway = getGateway()
    const toolRegistry = getToolRegistry()

    // ── 1. Resolve tools ──

    let tools = toolRegistry.resolveForExecution(agent.tools || [])

    // ── 2. Resolve provider / model ──
    // Must happen before sub-agent tool building so we can pass the resolved
    // provider to sub-agents when a model override is active. Tool routing also
    // uses this provider for its compact confirmation call.

    const providerId = providerOverride || agent.providerId || undefined
    const lastUsedProvider = providerId
        ? gateway.getProvider(providerId) || gateway.getLastUsedProvider()
        : gateway.getLastUsedProvider()
    // When a provider override is active without an explicit model override,
    // skip the agent's configured model (it belongs to a different provider)
    // and fall through to the new provider's default model.
    const model = modelOverride
        || (providerOverride ? undefined : agent.model)
        || lastUsedProvider.config.defaultModel

    // Always resolve to the actual provider ID so metrics track correctly
    const resolvedProviderId = lastUsedProvider.config.id

    // ── 2b. Context-aware MCP routing ──
    // Built-ins and sub-agent delegation tools bypass routing; this pass only
    // trims the MCP-backed portion of the agent's selected tool set.

    if (shouldRouteTools(tools, input.userQuery, { enabled: isToolRoutingEnabled(agent, input.autoToolRouting) })) {
        try {
            const routingTaskId = `router_${nanoid()}`
            emitToolRoutingStatus(conversationId, routingTaskId, 'routing-tools', 'Selecting relevant tools...')
            const routerProviderId = agent.toolRouterProviderId || input.toolRouterProviderId || resolvedProviderId
            const routerProvider = gateway.getProvider(routerProviderId) || lastUsedProvider
            const routerModel = agent.toolRouterModel || input.toolRouterModel || routerProvider.config.defaultModel || model

            tools = await routeTools({
                userQuery: input.userQuery || '',
                recentMessages: input.recentMessages || [],
                allTools: tools,
                gateway,
                providerId: routerProvider.config.id,
                model,
                routerModel,
                mcpMetadata: toolRegistry.getNamespaceMetadataForTools(tools),
                usedToolNames: input.usedToolNames,
            })
            emitToolRoutingSelection(conversationId, routingTaskId, tools)
        } catch (err) {
            console.warn('[tool-router] Routing failed, using full tool list:', err)
        }
    }

    // ── 3. Sub-agent delegation tools ──

    const effectiveSubAgents = includeSubAgents
        ? (subAgentAssignments ?? agent.subAgents)
        : undefined
    const hasSubAgents = Boolean(effectiveSubAgents?.length)

    if (hasSubAgents) {
        const { buildSubAgentTools } = await import('./sub-agent-tools.js')
        const subAgentTools = buildSubAgentTools({
            subAgents: effectiveSubAgents!,
            conversationId,
            broadcast,
            signal,
            modelOverride: overrideSubAgents ? (modelOverride || undefined) : undefined,
            providerOverride: overrideSubAgents ? (modelOverride ? lastUsedProvider.config.id : (providerOverride || undefined)) : undefined,
            toolRouterProviderId: input.toolRouterProviderId,
            toolRouterModel: input.toolRouterModel,
        })
        tools = [...tools, ...subAgentTools]
    }

    // ── 4. Hydrate built-in tool stubs ──

    tools = hydrateBuiltInTools(tools, {
        agentId: agent.id,
        conversationId,
        broadcast,
        memorySpaceOverrides,
    })

    // ── 5. System prompt ──

    const systemMessages: ChatMessage[] = []

    let effectiveSystemPrompt = systemPromptOverride ?? agent.systemPrompt ?? ''

    if (hasSubAgents) {
        const { buildSubAgentPrompt } = await import('./sub-agent-tools.js')
        effectiveSystemPrompt = (effectiveSystemPrompt ? effectiveSystemPrompt + '\n' : '') + buildSubAgentPrompt(effectiveSubAgents!)
    }

    if (systemPromptSuffix) {
        effectiveSystemPrompt = (effectiveSystemPrompt ? effectiveSystemPrompt + '\n' : '') + systemPromptSuffix
    }

    if (effectiveSystemPrompt) {
        // System prompt goes BEFORE memory context (insert at position 0)
        systemMessages.unshift({ role: 'system', content: effectiveSystemPrompt })
    }

    return {
        tools,
        providerId: resolvedProviderId,
        model,
        systemMessages,
        hasSubAgents,
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
            .filter((tool) => tool.namespaceId?.startsWith('mcp:'))
            .map((tool) => ({ name: tool.name, arguments: '{}' })),
    })
}

function isToolRoutingEnabled(agent: AgentData, sessionEnabled?: boolean): boolean {
    const routingPrefs = agent as AgentData & {
        autoToolRouting?: boolean
        toolRoutingEnabled?: boolean
        disableToolRouting?: boolean
    }

    if (routingPrefs.disableToolRouting === true) return false
    if (routingPrefs.toolRoutingEnabled === false) return false
    return sessionEnabled === true || routingPrefs.autoToolRouting === true || routingPrefs.toolRoutingEnabled === true
}
