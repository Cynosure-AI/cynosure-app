import { prepareAgentExecution } from '../prepare-execution.js'
import { presetFromAgent, presetFromAgentless } from '../execution-preset.js'
import { toExecutionPlanInput } from './execution-input.js'
import { isBuiltInEntityGraphToolKey, isBuiltInMemoryToolKey } from '../../tools/built-in-tools.js'
import {
    buildOrchestrationStateContext,
    getLatestOrchestrationState,
    resumeOrCreateOrchestrationRun,
    type OrchestrationState,
} from '../orchestration-state.js'
import {
    makeOrchestrationTools,
    ORCHESTRATOR_SYSTEM_PROMPT,
} from '../../tools/builtin/orchestration-tools.js'
import { isVisibleExecutionTool } from '../../tools/tool-policy.js'
import type { ExecutionPlanInput, ExecutionRequest } from './execution-input.js'
import type { ChatMessage, ToolDefinition } from '../../gateway/providers/base.provider.js'

export interface PlannedExecution {
    tools: ToolDefinition[]
    messages: ChatMessage[]
    providerId: string | undefined
    responseProvider: string
    responseModel: string
    hasSubAgents: boolean
    orchestrationRunId?: string
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
        memorySpaceOverrides,
        autoToolRouting,
        autoMemory,
        skillRouterProviderId,
        skillRouterModel,
        hasExplicitToolAllowlist = false,
        usedToolNames,
        selectedSkillIds = [],
        autoSkillRouting = false,
    } = input
    const selectedToolKeys = stripRuntimeMemoryToolKeys(input.selectedToolKeys ?? [])
    const hasRequestToolSelection = input.selectedToolKeys !== undefined

    const allRegisteredToolKeys = toolRegistry.listRegisteredTools()
        .map((tool) => tool.key)
        .filter((key) => !isBuiltInMemoryToolKey(key))
        .filter((key) => !isBuiltInEntityGraphToolKey(key))
    const effectiveAutoToolRouting = autoToolRouting ?? resolvedAgent?.autoToolRouting ?? false
    const configuredTools = hasExplicitToolAllowlist
        ? selectedToolKeys
        : resolvedAgent
            ? (stripRuntimeMemoryToolKeys(resolvedAgent.tools).length ? stripRuntimeMemoryToolKeys(resolvedAgent.tools) : (effectiveAutoToolRouting ? allRegisteredToolKeys : []))
            : allRegisteredToolKeys
    const fixedToolKeys = hasRequestToolSelection
        ? selectedToolKeys
        : stripRuntimeMemoryToolKeys(resolvedAgent?.tools ?? [])

    const effectiveSubAgents = requestedSubAgents ?? resolvedAgent?.subAgents ?? []
    const preset = resolvedAgent
        ? presetFromAgent(resolvedAgent, {
            tools: configuredTools,
            subAgents: effectiveSubAgents,
        })
        : presetFromAgentless({
            tools: configuredTools,
            skills: selectedSkillIds,
            subAgents: effectiveSubAgents,
            autoToolRouting: autoToolRouting === true,
            autoMemory,
            autoSkillRouting,
            skillRouterProviderId,
            skillRouterModel,
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
        skillRouterProviderId,
        skillRouterModel,
        preferredToolKeys: fixedToolKeys,
        usedToolNames,
        selectedSkillIds,
        autoSkillRouting,
        recentMessages: messages,
        userQuery: userText,
        memorySpaceOverrides,
    })

    const responseProvider = prepared.providerId || gateway.getLastUsedProvider().config.id
    const orchestration = applyOrchestrationIfToolCapable(
        conversationId,
        userText,
        prepared.tools,
        prepared.systemMessages,
    )

    return {
        tools: orchestration.tools,
        messages: [...orchestration.systemMessages, ...messages],
        providerId: prepared.providerId,
        responseProvider,
        responseModel: prepared.model,
        hasSubAgents: prepared.hasSubAgents,
        orchestrationRunId: orchestration.runId,
        chatAgentName: resolvedAgent?.name,
        chatAgentIconUrl: resolvedAgent?.iconUrl || null,
    }
}

function stripRuntimeMemoryToolKeys(toolKeys: string[]): string[] {
    return toolKeys.filter((key) => !isBuiltInMemoryToolKey(key))
}

function applyOrchestrationIfToolCapable(
    conversationId: string,
    objective: string,
    tools: ToolDefinition[],
    systemMessages: ChatMessage[],
): { tools: ToolDefinition[]; systemMessages: ChatMessage[]; runId?: string } {
    const hasVisibleExecutionTool = tools.some((tool) => isVisibleExecutionTool(tool.name))
    if (!hasVisibleExecutionTool) {
        return { tools, systemMessages }
    }

    const previousOrchestration = getLatestOrchestrationState(conversationId)
    const orchestration = resumeOrCreateOrchestrationRun(conversationId, objective)
    const orchestrationContext = buildOrchestrationTurnContext(orchestration, previousOrchestration)
    const mergedSystemMessages = appendSystemContext(
        appendSystemContext(systemMessages, ORCHESTRATOR_SYSTEM_PROMPT),
        orchestrationContext,
    )

    return {
        tools: [...tools, ...makeOrchestrationTools(orchestration.runId)],
        systemMessages: mergedSystemMessages,
        runId: orchestration.runId,
    }
}

function buildOrchestrationTurnContext(
    current: OrchestrationState,
    previous: OrchestrationState | null,
): string | null {
    const currentContext = buildOrchestrationStateContext(current)
    if (currentContext) return currentContext
    if (!previous || previous.runId === current.runId || !previous.items.length) return null

    const lines = previous.items.map((item) => {
        const note = item.note ? `; note=${item.note}` : ''
        return `- id=${item.id}; status=${item.status}; title=${item.title}${note}`
    })

    return [
        'Previous visible orchestration state for this conversation:',
        `objective=${previous.objective}`,
        ...lines,
        'A new empty orchestration run is active for the current user message.',
        'If the current message continues, expands, or changes this work and you will use visible execution tools, call orchestrator_set_tasks with the task list that should now be visible before using non-orchestration tools.',
        'If the previous list is still genuinely in progress after an interruption, use the prior task content as context and recreate the needed visible list for this run.',
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
