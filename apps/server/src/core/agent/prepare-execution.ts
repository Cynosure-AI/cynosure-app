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
import { resolveExecutionTools, resolveRoutingCandidateTools, isToolRoutingEnabled } from './pre-execution/execution-tools.js'
import { buildToolsetCandidates } from './pre-execution/auto-tool-routing.js'
import { resolveSystemPromptMessages } from './pre-execution/execution-prompts.js'
import { resolveMemoryContext, isAutoMemoryEnabled, hasExplicitEmptyMemoryScope } from './pre-execution/execution-memory.js'
import { buildTaskContext } from './pre-execution/task-context.js'
import { getAssignedMemoryFolders, type MemoryFolderRef } from '../memory/memory-folder-scope.js'
import type { SubAgentAssignment } from '../agents/agent-store.js'
import { isCyno, type ExecutionPreset } from './execution-preset.js'
import type { ChatMessage, RegistryAwareToolDefinition } from '../gateway/providers/base.provider.js'
import { getUserSettings } from '../user-settings.js'
import { buildUserContextPrompt, userMemoryFilingHint } from './pre-execution/user-context.js'
import type { ContextEvidence, ConversationExecutionConfig, ReasoningEffort } from '@shared/types'
import { MEMORY_WRITE_TOOL_NAMES } from '../tools/builtin/memory-tools.js'
import { mergeProjectMemoryScope, resolveProjectExecutionContext } from '../projects/project-context.js'
import { getPermissionMode } from '../chat/permission-mode.js'
import { isReadOnlyModeTool } from '../tools/tool-policy.js'
import { buildMcpInstructionsPrompt } from '../tools/mcp/mcp-instructions.js'

const MEMORY_STEWARDSHIP_PROMPT = `When maintaining memory, treat canonical files as the source of truth and retrieval chunks as search-only indexes. Search before creating, patch matching files instead of duplicating facts or appending change logs, and include enough unchanged context for every patch hunk to resolve uniquely. Use Title Case paths such as People/<Person>, Projects/<Project>, Organizations/<Organization>, or Topics/<Topic>. Keep related information together in coherent files; chunk boundaries are not editing boundaries. Use Uncategorized only when no clear category exists.`

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
    /** Optional allowlist for the automatic router's candidate catalogue. */
    routingToolKeys?: string[]
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

    // ── Cyno (no agent) overrides ──

    /** Memory folder overrides for the run (bypasses the agent's assigned folders) */
    memoryFolderOverrides?: MemoryFolderRef[]
    /** Agent id used during built-in tool hydration. Defaults to agent.id. */
    hydrationAgentId?: string
    /** Extra metadata to merge into emitted EventBus events during pre-execution routing (e.g. maCodename for sub-agents). */
    eventMeta?: Record<string, unknown>
    /** Explicitly selected tools to preserve when a Cyno chat schedules a job. */
    scheduleSelectedToolKeys?: string[]
    thinkingEnabled?: boolean
    reasoningEffort?: ReasoningEffort
    /** Include the user's standing instructions in the system prompt (default: true). */
    includeUserInstructions?: boolean
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
export async function prepareAgentExecution(rawInput: PrepareExecutionInput): Promise<PreparedExecution> {
    // A conversation that belongs to a project runs inside it: the project adds
    // instructions, state, memory scope, and tools. Sub-agents share the parent
    // conversation id, so they inherit the same project context.
    const project = resolveProjectExecutionContext(
        rawInput.conversationId,
        rawInput.broadcast,
        isCyno(rawInput.preset) ? undefined : rawInput.preset.id,
        // Cyno (no agent) leads the projects it works in; specialist agents work on their part.
        { lead: isCyno(rawInput.preset) },
    )
    const input: PrepareExecutionInput = project
        ? {
            ...rawInput,
            memoryFolderOverrides: mergeProjectMemoryScope({
                overrides: rawInput.memoryFolderOverrides,
                projectFolders: project.memoryFolders,
                assignedFolders: () => getAssignedMemoryFolders(rawInput.preset.id),
                isCyno: isCyno(rawInput.preset),
            }),
            systemPromptSuffix: [rawInput.systemPromptSuffix, project.systemPrompt].filter(Boolean).join('\n\n'),
        }
        : rawInput
    const {
        preset,
        conversationId,
        providerOverride,
        modelOverride,
        systemPromptOverride,
        systemPromptSuffix,
        memoryFolderOverrides,
    } = input

    const gateway = getGateway()
    const toolRegistry = getToolRegistry()
    const userSettings = getUserSettings()
    // Sub-agents share the conversation id, so they run under the chat's mode too.
    const readOnlyTools = getPermissionMode(conversationId) === 'read-only'

    const providerModel = resolveProviderAndModel({
        gateway,
        baseProviderId: preset.providerId,
        baseModel: preset.model,
        providerOverride,
        modelOverride,
    })
    const scheduleExecutionConfig: ConversationExecutionConfig | undefined = isCyno(preset)
        ? {
            allowedTools: [...(input.scheduleSelectedToolKeys ?? preset.tools)],
            subAgents: (input.subAgentAssignments ?? preset.subAgents).map(({ agentId }) => ({ agentId })),
            memoryFolderIds: memoryFolderOverrides?.map((space) => space.id) ?? [],
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
        memories: !hasExplicitEmptyMemoryScope(memoryFolderOverrides) && isAutoMemoryEnabled(preset, input.autoMemory),
    }
    const taskContextRouter = resolveTaskContextRouter({
        gateway,
        preset,
        fallbackProviderId: providerModel.providerId,
        fallbackModel: providerModel.model,
        requestRouterProviderId: input.autoRouterProviderId,
        requestRouterModel: input.autoRouterModel,
    })
    // The planning call also picks toolsets, which saves a separate selector call before tool routing.
    const routingCandidateTools = autoModes.tools
        ? resolveRoutingCandidateTools({
            preset,
            toolRegistry,
            preferredToolKeys: input.preferredToolKeys,
            routingToolKeys: input.routingToolKeys,
        }).filter((tool) => !readOnlyTools || isReadOnlyModeTool(tool))
        : []
    const taskContext = await buildTaskContext({
        conversationId,
        gateway,
        providerId: taskContextRouter.providerId,
        model: taskContextRouter.model,
        userQuery: input.userQuery,
        recentMessages: input.recentMessages,
        enabledModes: autoModes,
        userName: userSettings.name,
        toolsets: buildToolsetCandidates(
            routingCandidateTools,
            toolRegistry.getNamespaceMetadataForTools(routingCandidateTools),
        ),
        eventMeta: input.eventMeta,
        signal: input.signal,
    })
    const toolRoutingQuery = uniqueQueries([input.userQuery, taskContext?.toolSearchQuery]).join('\n') || input.userQuery
    const memoryRoutingQueries = uniqueQueries([
        input.userQuery,
        ...(taskContext?.memorySearchQueries || []),
    ])
    // Query rewriting complements recent conversational context; it does not
    // replace it, so both routers still receive input.recentMessages.
    // Tool selection and memory retrieval share the prepared queries and run concurrently.
    const [toolLayer, memoryContext] = await Promise.all([resolveExecutionTools({
        ...input,
        toolRegistry,
        gateway,
        resolvedProviderId: taskContextRouter.providerId,
        resolvedModel: taskContextRouter.model,
        userQuery: toolRoutingQuery,
        // The planned capability query already resolves the conversation.
        standaloneRoutingQuery: Boolean(taskContext?.toolSearchQuery),
        suppressAutoTools: taskContext?.requiresTools === false,
        plannedToolsetIds: taskContext?.toolsetIds,
        scheduleExecutionConfig,
        readOnlyTools,
    }), resolveMemoryContext({
        ...input,
        gateway,
        providerId: taskContextRouter.providerId,
        model: taskContextRouter.model,
        standaloneQuery: taskContext?.memoryQuery,
        retrievalQueries: memoryRoutingQueries,
        suppressAutoMemory: taskContext?.requiresMemory === false,
    })])

    const promptMessages = await resolveSystemPromptMessages({
        basePrompt: preset.systemPrompt,
        overridePrompt: systemPromptOverride,
        suffix: toolLayer.tools.some(tool => MEMORY_WRITE_TOOL_NAMES.includes((tool.originalName ?? tool.name) as never))
            ? [systemPromptSuffix, MEMORY_STEWARDSHIP_PROMPT, userMemoryFilingHint(userSettings.name)].filter(Boolean).join('\n')
            : systemPromptSuffix,
        subAgents: toolLayer.effectiveSubAgents,
        smartTagContext: {
            userName: userSettings.name,
            agentId: preset.id,
            agentName: preset.name,
            agentInternalName: preset.internalName,
            providerId: providerModel.providerId,
            model: providerModel.model,
            conversationId,
            selectedMemFolderNames: resolveSelectedMemoryFolderNames(preset.id, memoryFolderOverrides),
        },
        userContext: buildUserContextPrompt(userSettings, { includeInstructions: input.includeUserInstructions !== false }),
        mcpInstructions: buildMcpInstructionsPrompt(toolLayer.tools),
    })

    const systemMessages = [
        ...promptMessages,
        ...(project?.stateMessage ? [project.stateMessage] : []),
        ...memoryContext.messages,
    ]
    const projectTools = (project?.tools ?? []).filter((tool) => !readOnlyTools || isReadOnlyModeTool(tool))
    const projectToolNames = new Set(projectTools.map((tool) => tool.name))

    return {
        tools: project
            ? [...toolLayer.tools.filter((tool) => !projectToolNames.has(tool.name)), ...projectTools]
            : toolLayer.tools,
        providerId: providerModel.providerId,
        model: providerModel.model,
        contextBundle: { messages: systemMessages, evidence: memoryContext.evidence },
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
    memoryFolderOverrides: MemoryFolderRef[] | undefined,
): Array<{ name: string; description?: string }> {
    if (Array.isArray(memoryFolderOverrides)) {
        return memoryFolderOverrides.map(({ name, description }) => ({ name, ...(description ? { description } : {}) }))
    }

    if (isCyno({ id: agentId })) return []

    return getAssignedMemoryFolders(agentId).map(({ name, description }) => ({ name, ...(description ? { description } : {}) }))
}
