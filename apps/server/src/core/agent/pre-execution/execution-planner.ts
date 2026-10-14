import { prepareAgentExecution } from '../prepare-execution.js'
import { defaultAutoModes, snapshotChatExecutionPreset } from '../execution-preset.js'
import { getBuiltInMemoryToolKeys, getBuiltInToolKey, isBuiltInMemoryToolKey } from '../../tools/built-in-tools.js'
import {
    buildPlanningStateContext,
    getLatestPlanningState,
    resumeOrCreatePlanningRun,
    type PlanningState,
} from '../planning-state.js'
import {
    makePlanningTools,
    PLANNING_SYSTEM_PROMPT,
} from '../../tools/builtin/planning-tools.js'
import { isVisibleExecutionTool } from '../../tools/tool-policy.js'
import { isProjectToolName } from '../../projects/project-tools.js'
import { DIRECT_TOOL_SELECTION_LIMIT } from '../../runtime-limits.js'
import type { ExecutionRequest } from './execution-input.js'
import { assembleExecutionMessages } from '../../chat/message-history.js'
import type { ContextEvidence } from '@shared/types'
import type { ChatMessage, ToolDefinition } from '../../gateway/providers/base.provider.js'

export interface PlannedExecution {
    tools: ToolDefinition[]
    messages: ChatMessage[]
    providerId: string | undefined
    responseProvider: string
    responseModel: string
    hasSubAgents: boolean
    evidence: ContextEvidence[]
    planningRunId?: string
    chatAgentName?: string
    chatAgentIconUrl?: string | null
}

export interface ExecutionToolPolicy {
    configuredTools: string[]
    fixedToolKeys: string[]
    routingToolKeys?: string[]
    autoToolRouting: boolean
}

export async function planExecution(request: ExecutionRequest): Promise<PlannedExecution> {
    const {
        resolvedAgent,
        conversationId,
        broadcast,
        abortSignal,
        gateway,
        toolRegistry,
        messages,
        userText,
        eventMeta,
    } = request
    const run = request.run ?? {}
    const {
        providerOverride,
        modelOverride,
        systemPrompt,
        systemPromptSuffix,
        requestedSubAgents,
        memoryFolderOverrides,
        autoRouterProviderId,
        autoRouterModel,
        hasExplicitToolAllowlist = false,
        usedToolNames,
        thinkingEnabled,
        reasoningEffort,
        inlineAttachmentTextLimit,
    } = run
    const autoToolRouting = run.autoToolRouting ?? defaultAutoModes(resolvedAgent).autoToolRouting
    const autoMemory = run.autoMemory ?? defaultAutoModes(resolvedAgent).autoMemory
    const selectedToolKeys = stripAutomaticallyManagedMemoryToolKeys(run.selectedToolKeys ?? [])
    const hasRequestToolSelection = run.selectedToolKeys !== undefined

    const allRegisteredToolKeys = listRoutableToolKeys(toolRegistry)
    const agentToolKeys = stripAutomaticallyManagedMemoryToolKeys(resolvedAgent?.tools ?? [])
    const toolPolicy = resolveExecutionToolPolicy({
        selectedToolKeys,
        hasRequestToolSelection,
        agentToolKeys,
        allRegisteredToolKeys,
        hasExplicitToolAllowlist,
        autoToolRouting,
        hasResolvedAgent: Boolean(resolvedAgent),
    })

    const effectiveSubAgents = requestedSubAgents ?? resolvedAgent?.subAgents ?? []
    const preset = snapshotChatExecutionPreset(resolvedAgent, {
        tools: toolPolicy.configuredTools,
        subAgents: effectiveSubAgents,
        autoToolRouting,
        autoMemory,
        autoRouterProviderId,
        autoRouterModel,
    })

    const prepared = await prepareAgentExecution({
        preset,
        conversationId,
        broadcast,
        providerOverride,
        modelOverride,
        systemPromptOverride: systemPrompt,
        systemPromptSuffix,
        includeSubAgents: effectiveSubAgents.length > 0,
        subAgentAssignments: effectiveSubAgents,
        signal: abortSignal,
        autoToolRouting: toolPolicy.autoToolRouting,
        autoMemory,
        autoRouterProviderId,
        autoRouterModel,
        preferredToolKeys: toolPolicy.fixedToolKeys,
        routingToolKeys: toolPolicy.routingToolKeys,
        usedToolNames,
        // Every current caller has already appended the active user turn to
        // `messages`. The routing passes receive it separately as `userQuery`,
        // so exclude that last turn from recent history to avoid duplicate
        // context and wasted router tokens.
        recentMessages: messages.at(-1)?.role === 'user' ? messages.slice(0, -1) : messages,
        userQuery: userText,
        memoryFolderOverrides,
        eventMeta,
        inlineAttachmentTextLimit,
        scheduleSelectedToolKeys: selectedToolKeys,
        thinkingEnabled,
        reasoningEffort,
    })

    const responseProvider = prepared.providerId || gateway.getLastUsedProvider().config.id
    const responseSupportsToolCalls = await gateway.modelSupportsToolCalls(prepared.model, responseProvider)
    const responseTools = responseSupportsToolCalls ? prepared.tools : []
    const effectiveThinkingEnabled = thinkingEnabled ?? (resolvedAgent?.thinkingEnabled !== false)
    const planning = applyPlanningIfToolCapable(
        conversationId,
        userText,
        responseTools,
        prepared.contextBundle.messages,
        effectiveThinkingEnabled,
    )

    return {
        tools: planning.tools,
        messages: assembleExecutionMessages(planning.contextMessages, messages),
        providerId: prepared.providerId,
        responseProvider,
        responseModel: prepared.model,
        hasSubAgents: prepared.hasSubAgents,
        evidence: prepared.contextBundle.evidence,
        planningRunId: planning.runId,
        chatAgentName: resolvedAgent?.name,
        chatAgentIconUrl: resolvedAgent?.iconUrl || null,
    }
}

/** Registry keys an agent may receive implicitly; memory and MCP management are opted into separately. */
export function listRoutableToolKeys(toolRegistry: ExecutionRequest['toolRegistry']): string[] {
    return toolRegistry.listRegisteredTools()
        .map((tool) => tool.key)
        .filter((key) => !isBuiltInMemoryToolKey(key))
        .filter((key) => key !== getBuiltInToolKey('manage_mcp'))
}

export function stripAutomaticallyManagedMemoryToolKeys(toolKeys: string[]): string[] {
    const automaticallyManagedKeys = new Set(getBuiltInMemoryToolKeys())
    return toolKeys.filter((key) => !automaticallyManagedKeys.has(key))
}

export function resolveExecutionToolPolicy(input: {
    selectedToolKeys: string[]
    hasRequestToolSelection: boolean
    agentToolKeys: string[]
    allRegisteredToolKeys: string[]
    hasExplicitToolAllowlist: boolean
    autoToolRouting: boolean
    hasResolvedAgent: boolean
}): ExecutionToolPolicy {
    const manualToolKeys = input.hasRequestToolSelection ? input.selectedToolKeys : input.agentToolKeys
    if (manualToolKeys.length > DIRECT_TOOL_SELECTION_LIMIT) {
        return {
            configuredTools: manualToolKeys,
            fixedToolKeys: [],
            routingToolKeys: manualToolKeys,
            autoToolRouting: true,
        }
    }

    const configuredTools = input.hasExplicitToolAllowlist
        ? input.selectedToolKeys
        : input.hasResolvedAgent
            ? (input.agentToolKeys.length
                ? input.agentToolKeys
                : (input.autoToolRouting ? input.allRegisteredToolKeys : []))
            : input.allRegisteredToolKeys

    return {
        configuredTools,
        fixedToolKeys: manualToolKeys,
        autoToolRouting: input.autoToolRouting,
    }
}

function applyPlanningIfToolCapable(
    conversationId: string,
    objective: string,
    tools: ToolDefinition[],
    contextMessages: ChatMessage[],
    thinkingEnabled: boolean,
): { tools: ToolDefinition[]; contextMessages: ChatMessage[]; runId?: string } {
    if (!thinkingEnabled) {
        return { tools, contextMessages }
    }

    // Project tools are present in every project run; they alone do not warrant a todo list.
    const hasVisibleExecutionTool = tools.some((tool) => isVisibleExecutionTool(tool.name) && !isProjectToolName(tool.name))
    if (!hasVisibleExecutionTool) {
        return { tools, contextMessages }
    }

    const previousPlanning = getLatestPlanningState(conversationId)
    const planning = resumeOrCreatePlanningRun(conversationId, objective)
    const planningContext = buildPlanningTurnContext(planning, previousPlanning)
    // The instructions are static and belong in the system prompt; the todo
    // list changes between turns, so it travels as turn-local context.
    const withInstructions = appendSystemContext(contextMessages, PLANNING_SYSTEM_PROMPT)

    return {
        tools: [...tools, ...makePlanningTools(planning.runId)],
        contextMessages: planningContext
            ? [...withInstructions, {
                role: 'user',
                content: `[Planning state]\n${planningContext}\n[/Planning state]`,
                metadata: { contextKind: 'planning-state' },
            }]
            : withInstructions,
        runId: planning.runId,
    }
}

function buildPlanningTurnContext(
    current: PlanningState,
    previous: PlanningState | null,
): string | null {
    const currentContext = buildPlanningStateContext(current)
    if (currentContext) return currentContext
    if (!previous || previous.runId === current.runId || !previous.items.length) return null

    const lines = previous.items.map((item) => {
        const note = item.note ? `; note=${item.note}` : ''
        return `- id=${item.id}; status=${item.status}; title=${item.title}${note}`
    })

    return [
        'Previous visible planning todo list for this conversation:',
        `objective=${previous.objective}`,
        ...lines,
        'A planning run is active for the current user message.',
        'If this work continues or changes, call todo_update with the complete current tasks array before using non-planning tools.',
        'Use the prior task content as context; include only tasks that still belong to this request.',
    ].join('\n')
}

function appendSystemContext(messages: ChatMessage[], context: string | null): ChatMessage[] {
    if (!context) return messages
    let systemIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'system') {
            systemIndex = i
            break
        }
    }

    if (systemIndex === -1) {
        return [{ role: 'system', content: context }, ...messages]
    }

    return messages.map((message, index) => {
        if (index !== systemIndex) return message
        const content = typeof message.content === 'string'
            ? message.content
            : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
        return {
            ...message,
            content: `${content}\n\n${context}`,
        }
    })
}
