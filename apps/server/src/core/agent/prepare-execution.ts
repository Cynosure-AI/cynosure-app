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
import { resolveProviderAndModel } from './pre-execution/execution-resolvers.js'
import { resolveExecutionTools } from './pre-execution/execution-tools.js'
import { resolveSkillSystemPrompt } from './pre-execution/execution-skills.js'
import { resolveSystemPromptMessages } from './pre-execution/execution-prompts.js'
import { resolveMemorySystemMessages } from './pre-execution/execution-memory.js'
import type { SubAgentAssignment } from '../agents/agent-store.js'
import type { ExecutionPreset } from './execution-preset.js'
import type { ChatMessage, RegistryAwareToolDefinition } from '../gateway/providers/base.provider.js'

type BroadcastFn = (event: string, data: unknown) => void

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
    /** Optional provider override for the skill router confirmation pass */
    skillRouterProviderId?: string
    /** Optional model override for the skill router confirmation pass */
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

    const toolLayer = await resolveExecutionTools({
        preset,
        conversationId,
        broadcast,
        toolRegistry,
        resolvedProviderId: providerModel.providerId,
        providerOverride,
        modelOverride,
        userQuery: input.userQuery,
        recentMessages: input.recentMessages,
        usedToolNames: input.usedToolNames,
        preferredToolKeys: input.preferredToolKeys,
        autoToolRouting: input.autoToolRouting,
        autoMemory: input.autoMemory,
        includeSubAgents: input.includeSubAgents,
        subAgentAssignments: input.subAgentAssignments,
        signal: input.signal,
        memorySpaceOverrides,
        hydrationAgentId: input.hydrationAgentId,
    })

    const skillsPrompt = await resolveSkillSystemPrompt({
        preset,
        gateway,
        conversationId,
        providerId: providerModel.providerId,
        model: providerModel.model,
        userQuery: input.userQuery,
        recentMessages: input.recentMessages,
        selectedSkillIds: input.selectedSkillIds,
        autoSkillRouting: input.autoSkillRouting,
        skillRouterProviderId: input.skillRouterProviderId,
        skillRouterModel: input.skillRouterModel,
    })

    const systemMessages = [
        ...await resolveSystemPromptMessages({
            basePrompt: preset.systemPrompt,
            overridePrompt: systemPromptOverride,
            suffix: systemPromptSuffix,
            skillsPrompt,
            subAgents: toolLayer.effectiveSubAgents,
        }),
        ...await resolveMemorySystemMessages({
            preset,
            conversationId,
            autoMemory: input.autoMemory,
            memorySpaceOverrides,
            userQuery: input.userQuery,
            recentMessages: input.recentMessages,
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
