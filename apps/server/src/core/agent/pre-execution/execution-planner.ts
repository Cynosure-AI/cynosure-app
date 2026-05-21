import { prepareAgentExecution } from '../prepare-execution.js'
import { presetFromAgent, presetFromAgentless } from '../execution-preset.js'
import { toExecutionPlanInput } from './execution-input.js'
import type { ExecutionPlanInput, ExecutionRequest } from './execution-input.js'
import type { ChatMessage, ToolDefinition } from '../../gateway/providers/base.provider.js'

export interface PlannedExecution {
    tools: ToolDefinition[]
    messages: ChatMessage[]
    providerId: string | undefined
    responseProvider: string
    responseModel: string
    hasSubAgents: boolean
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

    const configuredTools = hasExplicitToolAllowlist
        ? selectedToolKeys
        : (resolvedAgent?.tools?.length
            ? resolvedAgent.tools
            : toolRegistry.listRegisteredTools().map((tool) => tool.key))
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

    return {
        tools: prepared.tools,
        messages: [...prepared.systemMessages, ...messages],
        providerId: prepared.providerId,
        responseProvider,
        responseModel: prepared.model,
        hasSubAgents: prepared.hasSubAgents,
        chatAgentName: resolvedAgent?.name,
        chatAgentIconUrl: resolvedAgent?.iconUrl || null,
    }
}
