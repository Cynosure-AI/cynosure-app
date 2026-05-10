import { prepareAgentExecution } from '../prepare-execution.js'
import { applyAutoToolRouting } from './auto-tool-routing.js'
import { resolveProviderAndModel, resolveRouterProviderModel } from './execution-resolvers.js'
import { hydrateBuiltInTools } from '../../tools/built-in-tools.js'
import type { AgentData, SubAgentAssignment } from '../../agents/agent-store.js'
import type { LLMGateway } from '../../gateway/gateway.js'
import type { ChatMessage, ToolDefinition } from '../../gateway/providers/base.provider.js'
import type { ToolRegistry } from '../../tools/tool-registry.js'

type BroadcastFn = (event: string, data: unknown) => void

export interface PlanChatExecutionInput {
    resolvedAgent: AgentData | null
    conversationId: string
    broadcast: BroadcastFn
    abortSignal: AbortSignal
    gateway: LLMGateway
    toolRegistry: ToolRegistry
    messages: ChatMessage[]
    userText: string
    providerOverride?: string
    modelOverride?: string
    systemPrompt?: string
    systemPromptSuffix?: string
    requestedSubAgents?: SubAgentAssignment[]
    memorySpaceOverrides?: { id: string; name: string }[]
    overrideSubAgents?: boolean
    autoToolRouting?: boolean
    toolRouterProviderId?: string
    toolRouterModel?: string
    selectedToolKeys?: string[]
    hasExplicitToolAllowlist?: boolean
    stickyPreferredToolNames?: string[]
}

export interface PlannedChatExecution {
    tools: ToolDefinition[]
    messages: ChatMessage[]
    providerId: string | undefined
    responseProvider: string
    responseModel: string
    hasSubAgents: boolean
    chatAgentName?: string
    chatAgentIconUrl?: string | null
}

export async function planChatExecution(input: PlanChatExecutionInput): Promise<PlannedChatExecution> {
    if (input.resolvedAgent) {
        return planAgentExecution(input)
    }
    return planAgentlessExecution(input)
}

async function planAgentExecution(input: PlanChatExecutionInput): Promise<PlannedChatExecution> {
    const {
        resolvedAgent,
        conversationId,
        broadcast,
        abortSignal,
        gateway,
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
        selectedToolKeys = [],
        hasExplicitToolAllowlist = false,
    } = input

    const effectiveSubAgents = requestedSubAgents ?? resolvedAgent!.subAgents
    const effectiveAgent = hasExplicitToolAllowlist
        ? { ...resolvedAgent!, tools: selectedToolKeys }
        : resolvedAgent!

    const prepared = await prepareAgentExecution({
        agent: effectiveAgent,
        conversationId,
        broadcast,
        providerOverride: providerOverride || undefined,
        modelOverride: modelOverride || undefined,
        systemPromptOverride: systemPrompt || undefined,
        systemPromptSuffix,
        subAgentAssignments: effectiveSubAgents,
        signal: abortSignal,
        userQuery: userText,
        recentMessages: messages,
        memorySpaceOverrides,
        overrideSubAgents,
        autoToolRouting,
        toolRouterProviderId,
        toolRouterModel,
        preferredToolKeys: selectedToolKeys,
    })

    const provider = prepared.providerId
        ? gateway.getProvider(prepared.providerId) || gateway.getLastUsedProvider()
        : gateway.getLastUsedProvider()

    return {
        tools: prepared.tools,
        messages: [...prepared.systemMessages, ...messages],
        providerId: prepared.providerId,
        responseProvider: provider.config.id,
        responseModel: prepared.model,
        hasSubAgents: prepared.hasSubAgents,
        chatAgentName: resolvedAgent!.name,
        chatAgentIconUrl: resolvedAgent!.iconUrl || null,
    }
}

async function planAgentlessExecution(input: PlanChatExecutionInput): Promise<PlannedChatExecution> {
    const {
        conversationId,
        broadcast,
        abortSignal,
        gateway,
        toolRegistry,
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
        selectedToolKeys = [],
        hasExplicitToolAllowlist = false,
        stickyPreferredToolNames = [],
    } = input

    let messages = input.messages
    if (systemPrompt) {
        messages = [{ role: 'system', content: systemPrompt }, ...messages]
    }
    if (systemPromptSuffix) {
        messages = [{ role: 'system', content: systemPromptSuffix }, ...messages]
    }

    let tools = hasExplicitToolAllowlist
        ? toolRegistry.resolveForExecution(selectedToolKeys)
        : toolRegistry.getToolDefinitions()

    const providerModel = resolveProviderAndModel({
        gateway,
        providerOverride,
        modelOverride,
    })
    const routerModelConfig = resolveRouterProviderModel({
        gateway,
        fallbackProviderId: providerModel.providerId,
        fallbackModel: providerModel.model,
        requestRouterProviderId: toolRouterProviderId,
        requestRouterModel: toolRouterModel,
    })

    const providerId = providerOverride || undefined
    const responseProvider = providerModel.providerId
    const responseModel = providerModel.model

    tools = await applyAutoToolRouting({
        enabled: autoToolRouting,
        conversationId,
        userQuery: userText,
        recentMessages: messages,
        tools,
        gateway,
        providerId: routerModelConfig.providerId,
        model: responseModel,
        routerModel: routerModelConfig.model,
        mcpMetadata: toolRegistry.getNamespaceMetadataForTools(tools),
        preferredToolNames: stickyPreferredToolNames.length ? new Set(stickyPreferredToolNames) : undefined,
    })

    let hasSubAgents = false
    if (requestedSubAgents?.length) {
        const { buildSubAgentTools, buildSubAgentPrompt } = await import('../sub-agent-tools.js')
        messages = [{ role: 'system', content: buildSubAgentPrompt(requestedSubAgents) }, ...messages]
        const subAgentTools = buildSubAgentTools({
            subAgents: requestedSubAgents,
            conversationId,
            broadcast,
            signal: abortSignal,
            modelOverride: overrideSubAgents ? (modelOverride || undefined) : undefined,
            providerOverride: overrideSubAgents ? responseProvider : undefined,
        })
        tools = [...tools, ...subAgentTools]
        hasSubAgents = true
    }

    tools = hydrateBuiltInTools(tools, {
        agentId: undefined,
        conversationId,
        broadcast,
        memorySpaceOverrides,
    })

    return {
        tools,
        messages,
        providerId,
        responseProvider,
        responseModel,
        hasSubAgents,
    }
}
