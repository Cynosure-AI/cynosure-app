/**
 * Shared pre-action builder for agent execution.
 *
 * This module is intentionally a thin assembler. The individual execution
 * layers live under pre-execution/ so tools, memory, prompts, and
 * model resolution can evolve independently while callers keep one stable
 * preparation entry point.
 */

import { getGateway } from '../gateway/gateway.js'
import { getToolRegistry } from '../tools/tool-registry.js'
import { resolveProviderAndModel, resolveTaskContextRouter } from './pre-execution/execution-resolvers.js'
import { resolveExecutionTools, isToolRoutingEnabled } from './pre-execution/execution-tools.js'
import { resolveSystemPromptMessages } from './pre-execution/execution-prompts.js'
import { resolveMemoryContext, isAutoMemoryEnabled, hasExplicitEmptyMemoryScope } from './pre-execution/execution-memory.js'
import { ensureOversizedAttachmentsIndexed } from './pre-execution/execution-attachments.js'
import { buildTaskContext, inferRequestedToolEffect } from './pre-execution/task-context.js'
import { getAssignedOrDefaultSpaces, type MemorySpaceRef } from '../memory/memory-space-scope.js'
import type { SubAgentAssignment } from '../agents/agent-store.js'
import type { ExecutionPreset } from './execution-preset.js'
import type { ChatMessage, RegistryAwareToolDefinition } from '../gateway/providers/base.provider.js'
import { getUserSettings } from '../user-settings.js'
import type { ContextEvidence, ConversationExecutionConfig, ReasoningEffort } from '@shared/types'

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
    /** Optional provider override for the auto router pass. */
    autoRouterProviderId?: string
    /** Optional model override for the auto router pass. */
    autoRouterModel?: string
    // ── Sub-agents ──

    /** Whether to include sub-agent delegation tools (default: true) */
    includeSubAgents?: boolean
    /** Override agent.subAgents (e.g. when sub-agents come from the request body) */
    subAgentAssignments?: SubAgentAssignment[]
    /** Parent abort signal passed to sub-agent executors */
    signal?: AbortSignal

    // ── Agentless overrides ──

    /** Memory space overrides for agentless chat (bypasses agent's assigned spaces) */
    memorySpaceOverrides?: MemorySpaceRef[]
    /** Agent id used during built-in tool hydration. Defaults to agent.id. */
    hydrationAgentId?: string
    /** Extra metadata to merge into emitted EventBus events during pre-execution routing (e.g. maCodename for sub-agents). */
    eventMeta?: Record<string, unknown>
    /** Inline text threshold; larger conversation attachments are indexed before execution. */
    inlineAttachmentTextLimit?: number
    /** Capture auxiliary pre-turn model calls in the Debug Context inspector. */
    debugContextEnabled?: boolean
    /** Explicitly selected tools to preserve in agentless schedule snapshots. */
    scheduleSelectedToolKeys?: string[]
    thinkingEnabled?: boolean
    reasoningEffort?: ReasoningEffort
}

export interface ContextBundle {
    messages: ChatMessage[]
    evidence: ContextEvidence[]
}

export interface PreparedExecution {
    /** Tool definitions ready for the executor */
    tools: RegistryAwareToolDefinition[]
    /** Resolved provider ID */
    providerId: string | undefined
    /** Resolved model name */
    model: string
    /** Prepared model context plus the exact evidence that produced it. */
    contextBundle: ContextBundle
    /** Compatibility alias for contextBundle.messages. */
    systemMessages: ChatMessage[]
    /** Whether sub-agent delegation tools were added */
    hasSubAgents: boolean
}

/**
 * Prepare all shared pre-action state for agent execution.
 *
 * Returns resolved tools (with hydration + sub-agents), provider/model,
 * and prepared context messages (trusted prompt + lower-authority evidence).
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
    const scheduleExecutionConfig: ConversationExecutionConfig | undefined = preset.id === '__agentless__'
        ? {
            allowedTools: [...(input.scheduleSelectedToolKeys ?? preset.tools)],
            subAgents: [...(input.subAgentAssignments ?? preset.subAgents)],
            memorySpaceIds: memorySpaceOverrides?.map((space) => space.id) ?? [],
            systemPrompt: systemPromptOverride ?? preset.systemPrompt ?? '',
            model: providerModel.model,
            providerId: providerModel.providerId,
            thinkingEnabled: input.thinkingEnabled !== false,
            reasoningEffort: input.reasoningEffort ?? 'medium',
            autoToolRouting: input.autoToolRouting === true,
            autoMemory: input.autoMemory === true,
            autoRouterProviderId: input.autoRouterProviderId,
            autoRouterModel: input.autoRouterModel,
        }
        : undefined
    const autoModes = {
        tools: isToolRoutingEnabled(preset, input.autoToolRouting),
        memories: !hasExplicitEmptyMemoryScope(memorySpaceOverrides) && isAutoMemoryEnabled(preset, input.autoMemory),
    }
    const taskContextRouter = resolveTaskContextRouter({
        gateway,
        preset,
        fallbackProviderId: providerModel.providerId,
        fallbackModel: providerModel.model,
        requestRouterProviderId: input.autoRouterProviderId,
        requestRouterModel: input.autoRouterModel,
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
        signal: input.signal,
        debugContextEnabled: input.debugContextEnabled,
    })
    const toolRoutingQuery = uniqueQueries([input.userQuery, taskContext?.toolQuery]).join('\n') || input.userQuery
    const memoryRoutingQueries = uniqueQueries([
        input.userQuery,
        ...(taskContext?.memoryQueries || (taskContext?.memoryQuery ? [taskContext.memoryQuery] : [])),
    ])
    // Query rewriting complements recent conversational context; it does not
    // replace it. Follow-ups and pronouns still need the original turns.
    const routingMessages = input.recentMessages

    const attachmentPreparation = input.inlineAttachmentTextLimit !== undefined
        ? ensureOversizedAttachmentsIndexed({
            conversationId,
            inlineAttachmentTextLimit: input.inlineAttachmentTextLimit,
            eventMeta: input.eventMeta,
        })
        : Promise.resolve()

    // Tool selection and memory retrieval share the prepared queries and run concurrently.
    const [toolLayer, memoryContext] = await Promise.all([resolveExecutionTools({
        preset,
        conversationId,
        broadcast,
        toolRegistry,
        gateway,
        resolvedProviderId: taskContextRouter.providerId,
        resolvedModel: taskContextRouter.model,
        userQuery: toolRoutingQuery,
        requestedToolEffect: taskContext?.requestedToolEffect || inferRequestedToolEffect(input.userQuery || ''),
        suppressAutoTools: taskContext?.skipToolRouting === true,
        recentMessages: routingMessages,
        usedToolNames: input.usedToolNames,
        preferredToolKeys: input.preferredToolKeys,
        autoToolRouting: input.autoToolRouting,
        autoMemory: input.autoMemory,
        includeSubAgents: input.includeSubAgents,
        subAgentAssignments: input.subAgentAssignments,
        signal: input.signal,
        debugContextEnabled: input.debugContextEnabled,
        memorySpaceOverrides,
        hydrationAgentId: input.hydrationAgentId,
        eventMeta: input.eventMeta,
        scheduleExecutionConfig,
    }), resolveMemoryContext({
        preset,
        conversationId,
        gateway,
        providerId: taskContextRouter.providerId,
        model: taskContextRouter.model,
        autoMemory: input.autoMemory,
        memorySpaceOverrides,
        userQuery: input.userQuery,
        retrievalQueries: memoryRoutingQueries,
        recentMessages: routingMessages,
        eventMeta: input.eventMeta,
        signal: input.signal,
        debugContextEnabled: input.debugContextEnabled,
        suppressAutoMemory: taskContext?.skipMemoryRouting === true,
    }), attachmentPreparation])

    const promptMessages = await resolveSystemPromptMessages({
        basePrompt: preset.systemPrompt,
        overridePrompt: systemPromptOverride,
        suffix: systemPromptSuffix,
        subAgents: toolLayer.effectiveSubAgents,
        smartTagContext: {
            userName: getUserSettings().name,
            agentId: preset.id,
            agentName: preset.name,
            agentInternalName: preset.internalName,
            providerId: providerModel.providerId,
            model: providerModel.model,
            conversationId,
            selectedMemFolderNames: resolveSelectedMemoryFolderNames(preset.id, memorySpaceOverrides),
        },
    })

    const systemMessages = [
        ...promptMessages,
        ...memoryContext.messages,
    ]

    return {
        tools: toolLayer.tools,
        providerId: providerModel.providerId,
        model: providerModel.model,
        contextBundle: { messages: systemMessages, evidence: memoryContext.evidence },
        systemMessages,
        hasSubAgents: toolLayer.hasSubAgents,
    }
}

function uniqueQueries(values: Array<string | undefined>): string[] {
    return values
        .map((value) => value?.trim() || '')
        .filter(Boolean)
        .filter((value, index, all) => all.indexOf(value) === index)
}

function resolveSelectedMemoryFolderNames(
    agentId: string,
    memorySpaceOverrides: MemorySpaceRef[] | undefined,
): string[] {
    if (Array.isArray(memorySpaceOverrides)) {
        return memorySpaceOverrides.map((space) => space.name)
    }

    if (agentId === '__agentless__') return []

    return getAssignedOrDefaultSpaces(agentId).map((space) => space.name)
}
