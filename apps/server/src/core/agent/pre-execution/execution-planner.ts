import { prepareAgentExecution } from '../prepare-execution.js'
import { presetFromAgent, presetFromAgentless } from '../execution-preset.js'
import { toExecutionPlanInput } from './execution-input.js'
import { getBuiltInMemoryToolKeys, isBuiltInMemoryToolKey } from '../../tools/built-in-tools.js'
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
import { MANAGE_MCP_TOOL_NAME } from '../../tools/builtin/manage-mcp.js'
import type { ExecutionPlanInput, ExecutionRequest } from './execution-input.js'
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

export async function planExecution(request: ExecutionRequest): Promise<PlannedExecution> {
    return planExecutionInput(toExecutionPlanInput(request))
}

async function planExecutionInput(input: ExecutionPlanInput): Promise<PlannedExecution> {
    const {
        resolvedAgent,
        conversationId,
        broadcast,
        abortSignal,
        gateway,
        toolRegistry,
        messages,
        userText,
        providerOverride,
        modelOverride,
        systemPrompt,
        systemPromptSuffix,
        requestedSubAgents,
        memoryCategoryOverrides,
        autoToolRouting,
        autoMemory,
        autoRouterProviderId,
        autoRouterModel,
        hasExplicitToolAllowlist = false,
        usedToolNames,
        thinkingEnabled,
        reasoningEffort,
        eventMeta,
        inlineAttachmentTextLimit,
        debugContextEnabled,
    } = input
    const selectedToolKeys = stripAutomaticallyManagedMemoryToolKeys(input.selectedToolKeys ?? [])
    const hasRequestToolSelection = input.selectedToolKeys !== undefined

    const allRegisteredToolKeys = toolRegistry.listRegisteredTools()
        .map((tool) => tool.key)
        .filter((key) => !isBuiltInMemoryToolKey(key))
    const effectiveAutoToolRouting = autoToolRouting ?? resolvedAgent?.autoToolRouting ?? false
    const configuredTools = hasExplicitToolAllowlist
        ? selectedToolKeys
        : resolvedAgent
            ? (stripAutomaticallyManagedMemoryToolKeys(resolvedAgent.tools).length ? stripAutomaticallyManagedMemoryToolKeys(resolvedAgent.tools) : (effectiveAutoToolRouting ? allRegisteredToolKeys : []))
            : allRegisteredToolKeys
    const fixedToolKeys = hasRequestToolSelection
        ? selectedToolKeys
        : stripAutomaticallyManagedMemoryToolKeys(resolvedAgent?.tools ?? [])

    const effectiveSubAgents = requestedSubAgents ?? resolvedAgent?.subAgents ?? []
    const preset = resolvedAgent
        ? presetFromAgent(resolvedAgent, {
            tools: configuredTools,
            subAgents: effectiveSubAgents,
        })
        : presetFromAgentless({
            tools: configuredTools,
            subAgents: effectiveSubAgents,
            autoToolRouting: autoToolRouting === true,
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
        autoToolRouting,
        autoMemory,
        autoRouterProviderId,
        autoRouterModel,
        preferredToolKeys: fixedToolKeys,
        usedToolNames,
        // Every current caller has already appended the active user turn to
        // `messages`. The routing passes receive it separately as `userQuery`,
        // so exclude that last turn from recent history to avoid duplicate
        // context and wasted router tokens.
        recentMessages: messages.at(-1)?.role === 'user' ? messages.slice(0, -1) : messages,
        userQuery: userText,
        memoryCategoryOverrides,
        eventMeta,
        inlineAttachmentTextLimit,
        debugContextEnabled,
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
        messages: [...planning.systemMessages, ...messages],
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

export function stripAutomaticallyManagedMemoryToolKeys(toolKeys: string[]): string[] {
    const automaticallyManagedKeys = new Set(getBuiltInMemoryToolKeys())
    return toolKeys.filter((key) => !automaticallyManagedKeys.has(key))
}

function applyPlanningIfToolCapable(
    conversationId: string,
    objective: string,
    tools: ToolDefinition[],
    systemMessages: ChatMessage[],
    thinkingEnabled: boolean,
): { tools: ToolDefinition[]; systemMessages: ChatMessage[]; runId?: string } {
    if (!thinkingEnabled) {
        return { tools, systemMessages }
    }

    // manage_mcp is always available as a management capability. Its mere
    // presence should not activate planning for an otherwise tool-free chat.
    const hasVisibleExecutionTool = tools.some(
        (tool) => tool.name !== MANAGE_MCP_TOOL_NAME && isVisibleExecutionTool(tool.name),
    )
    if (!hasVisibleExecutionTool) {
        return { tools, systemMessages }
    }

    const previousPlanning = getLatestPlanningState(conversationId)
    const planning = resumeOrCreatePlanningRun(conversationId, objective)
    const planningContext = buildPlanningTurnContext(planning, previousPlanning)
    const mergedSystemMessages = appendSystemContext(
        appendSystemContext(systemMessages, PLANNING_SYSTEM_PROMPT),
        planningContext,
    )

    return {
        tools: [...tools, ...makePlanningTools(planning.runId)],
        systemMessages: mergedSystemMessages,
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
        'If the current message continues, expands, or changes this work and you will use visible execution tools, call todo_write with the task list that should now be visible before using non-planning tools.',
        'If the previous list is still genuinely in progress after an interruption, use the prior task content as context and update or recreate the needed visible list for this run.',
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
