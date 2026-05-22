import { prepareAgentExecution } from '../prepare-execution.js'
import { presetFromAgent, presetFromAgentless } from '../execution-preset.js'
import { toExecutionPlanInput } from './execution-input.js'
import {
    buildOrchestrationStateContext,
    resumeOrCreateOrchestrationRun,
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
        overrideSubAgents = true,
        autoToolRouting = false,
        toolRouterProviderId,
        toolRouterModel,
        hasExplicitToolAllowlist = false,
    } = input
    const selectedToolKeys = input.selectedToolKeys ?? []
    const hasRequestToolSelection = input.selectedToolKeys !== undefined

    const allRegisteredToolKeys = toolRegistry.listRegisteredTools().map((tool) => tool.key)
    const configuredTools = hasExplicitToolAllowlist
        ? selectedToolKeys
        : resolvedAgent
            ? (resolvedAgent.tools.length ? resolvedAgent.tools : (autoToolRouting ? allRegisteredToolKeys : []))
            : allRegisteredToolKeys
    const fixedToolKeys = hasRequestToolSelection
        ? selectedToolKeys
        : (resolvedAgent?.tools ?? [])

    const effectiveSubAgents = requestedSubAgents ?? resolvedAgent?.subAgents ?? []
    const preset = resolvedAgent
        ? presetFromAgent(resolvedAgent, {
            tools: configuredTools,
            subAgents: effectiveSubAgents,
        })
        : presetFromAgentless({
            tools: configuredTools,
            subAgents: effectiveSubAgents,
            autoToolRouting,
            toolRouterProviderId,
            toolRouterModel,
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
        overrideSubAgents,
        autoToolRouting,
        toolRouterProviderId,
        toolRouterModel,
        preferredToolKeys: fixedToolKeys,
        recentMessages: messages,
        userQuery: userText,
        memorySpaceOverrides,
        forceResolvedSubAgentProvider: true,
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

    const orchestration = resumeOrCreateOrchestrationRun(conversationId, objective)
    const orchestrationContext = buildOrchestrationStateContext(orchestration)
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
