/**
 * Shared pre-action builder for agent execution.
 *
 * This module is intentionally a thin assembler. The individual execution
 * layers live under pre-execution/ so tools, memory, skills, prompts, and
 * model resolution can evolve independently while callers keep one stable
 * preparation entry point.
 */

import { getGateway } from '../gateway/gateway.js'
import { getToolRegistry } from '../tools/tool-registry.js'
import { resolveProviderAndModel, resolveRouterProviderModel } from './pre-execution/execution-resolvers.js'
import { resolveExecutionTools } from './pre-execution/execution-tools.js'
import { resolveSkillSystemPrompt } from './pre-execution/execution-skills.js'
import { resolveSystemPromptMessages } from './pre-execution/execution-prompts.js'
import { resolveMemorySystemMessages } from './pre-execution/execution-memory.js'
import { appendTaskContextSystemMessage, buildTaskContext } from './pre-execution/task-context.js'
import type { SubAgentAssignment } from '../agents/agent-store.js'
import type { ExecutionPreset } from './execution-preset.js'
import type { LLMGateway } from '../gateway/gateway.js'
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
    /** Enable automatic memory retrieval for this execution. */
    autoMemory?: boolean
    /** Optional provider override for the auto router pass. Legacy name kept for API compatibility. */
    skillRouterProviderId?: string
    /** Optional model override for the auto router pass. Legacy name kept for API compatibility. */
    skillRouterModel?: string
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

    // ── Agentless overrides ──

    /** Memory space overrides for agentless chat (bypasses agent's assigned spaces) */
    memorySpaceOverrides?: { id: string; name: string }[]
    /** Agent id used during built-in tool hydration. Defaults to agent.id. */
    hydrationAgentId?: string
    /** Extra metadata to merge into emitted EventBus events during pre-execution routing (e.g. maCodename for sub-agents). */
    eventMeta?: Record<string, unknown>
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
        preset,
        conversationId,
        broadcast,
        providerOverride,
        modelOverride,
        systemPromptOverride,
        systemPromptSuffix,
        memorySpaceOverrides,
    } = input

    const gateway = getGateway()
    const toolRegistry = getToolRegistry()

    const providerModel = resolveProviderAndModel({
        gateway,
        baseProviderId: preset.providerId,
        baseModel: preset.model,
        providerOverride,
        modelOverride,
    })
    const autoModes = {
        tools: isToolRoutingEnabled(preset, input.autoToolRouting),
        skills: isSkillRoutingEnabled(preset, input.autoSkillRouting),
        memories: isAutoMemoryEnabled(preset, input.autoMemory, memorySpaceOverrides),
    }
    const taskContextRouter = resolveTaskContextRouter({
        gateway,
        preset,
        fallbackProviderId: providerModel.providerId,
        fallbackModel: providerModel.model,
        requestRouterProviderId: input.skillRouterProviderId,
        requestRouterModel: input.skillRouterModel,
    })
    const taskContext = await buildTaskContext({
        conversationId,
        gateway,
        providerId: taskContextRouter.providerId,
        model: taskContextRouter.model,
        userQuery: input.userQuery,
        recentMessages: input.recentMessages,
        enabledModes: autoModes,
        eventMeta: input.eventMeta,
    })
    const toolRoutingQuery = taskContext?.toolQuery || taskContext?.routerQuery || input.userQuery
    const skillRoutingQuery = taskContext?.skillQuery || taskContext?.routerQuery || input.userQuery
    const memoryRoutingQuery = taskContext?.memoryQuery || taskContext?.routerQuery || input.userQuery
    const routingMessages = taskContext ? [] : input.recentMessages

    const toolLayer = await resolveExecutionTools({
        preset,
        conversationId,
        broadcast,
        toolRegistry,
        resolvedProviderId: providerModel.providerId,
        providerOverride,
        modelOverride,
        userQuery: toolRoutingQuery,
        recentMessages: routingMessages,
        usedToolNames: input.usedToolNames,
        preferredToolKeys: input.preferredToolKeys,
        autoToolRouting: input.autoToolRouting,
        autoMemory: input.autoMemory,
        includeSubAgents: input.includeSubAgents,
        subAgentAssignments: input.subAgentAssignments,
        signal: input.signal,
        memorySpaceOverrides,
        hydrationAgentId: input.hydrationAgentId,
        eventMeta: input.eventMeta,
    })

    const skillsPrompt = await resolveSkillSystemPrompt({
        preset,
        gateway,
        conversationId,
        providerId: providerModel.providerId,
        model: providerModel.model,
        userQuery: skillRoutingQuery,
        recentMessages: routingMessages,
        selectedSkillIds: input.selectedSkillIds,
        autoSkillRouting: input.autoSkillRouting,
        skillRouterProviderId: input.skillRouterProviderId,
        skillRouterModel: input.skillRouterModel,
        eventMeta: input.eventMeta,
    })

    const promptMessages = appendTaskContextSystemMessage(
        await resolveSystemPromptMessages({
            basePrompt: preset.systemPrompt,
            overridePrompt: systemPromptOverride,
            suffix: systemPromptSuffix,
            skillsPrompt,
            subAgents: toolLayer.effectiveSubAgents,
        }),
        taskContext,
    )

    const systemMessages = [
        ...promptMessages,
        ...await resolveMemorySystemMessages({
            preset,
            conversationId,
            autoMemory: input.autoMemory,
            memorySpaceOverrides,
            userQuery: memoryRoutingQuery,
            recentMessages: routingMessages,
            eventMeta: input.eventMeta,
        }),
    ]

    return {
        tools: toolLayer.tools,
        providerId: providerModel.providerId,
        model: providerModel.model,
        systemMessages,
        hasSubAgents: toolLayer.hasSubAgents,
    }
}

function resolveTaskContextRouter(params: {
    gateway: LLMGateway
    preset: ExecutionPreset
    fallbackProviderId: string
    fallbackModel: string
    requestRouterProviderId?: string
    requestRouterModel?: string
}) {
    const useAgentRouterProvider = params.preset.skillRouterProviderId === AGENT_ROUTER_PROVIDER
    const useAgentRouterModel = params.preset.skillRouterModel === AGENT_ROUTER_MODEL
    return resolveRouterProviderModel({
        gateway: params.gateway,
        fallbackProviderId: params.fallbackProviderId,
        fallbackModel: params.fallbackModel,
        agentRouterProviderId: useAgentRouterProvider ? params.preset.providerId : (params.preset.skillRouterProviderId || undefined),
        agentRouterModel: useAgentRouterModel ? (params.preset.model || undefined) : (params.preset.skillRouterModel || undefined),
        requestRouterProviderId: params.requestRouterProviderId,
        requestRouterModel: useAgentRouterProvider ? undefined : params.requestRouterModel,
    })
}

function isToolRoutingEnabled(preset: ExecutionPreset, sessionEnabled?: boolean): boolean {
    if (preset.disableToolRouting === true) return false
    if (preset.toolRoutingEnabled === false) return false
    if (sessionEnabled === true) return true
    if (sessionEnabled === false) return false
    return preset.autoToolRouting === true || preset.toolRoutingEnabled === true
}

function isSkillRoutingEnabled(preset: ExecutionPreset, sessionEnabled?: boolean): boolean {
    if (sessionEnabled === true) return true
    if (sessionEnabled === false) return false
    return preset.autoSkillRouting === true
}

function isAutoMemoryEnabled(
    preset: ExecutionPreset,
    sessionEnabled: boolean | undefined,
    memorySpaceOverrides: { id: string; name: string }[] | undefined,
): boolean {
    if (Array.isArray(memorySpaceOverrides) && memorySpaceOverrides.length === 0) return false
    if (sessionEnabled === true) return true
    if (sessionEnabled === false) return false
    return preset.autoMemory === true
}
