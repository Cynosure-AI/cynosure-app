import type { AgentData, SubAgentAssignment } from '../../agents/agent-store.js'
import type { LLMGateway } from '../../gateway/gateway.js'
import type { ChatMessage } from '../../gateway/providers/base.provider.js'
import type { ToolRegistry } from '../../tools/tool-registry.js'

export type BroadcastFn = (event: string, data: unknown) => void

export interface ExecutionRequest {
    resolvedAgent: AgentData | null
    conversationId: string
    broadcast: BroadcastFn
    abortSignal: AbortSignal
    gateway: LLMGateway
    toolRegistry: ToolRegistry
    messages: ChatMessage[]
    userText: string
    run?: {
        providerOverride?: string
        modelOverride?: string
        systemPrompt?: string
        systemPromptSuffix?: string
        requestedSubAgents?: SubAgentAssignment[]
        memorySpaceOverrides?: { id: string; name: string }[]
        autoToolRouting?: boolean
        autoMemory?: boolean
        skillRouterProviderId?: string
        skillRouterModel?: string
        selectedToolKeys?: string[]
        hasExplicitToolAllowlist?: boolean
        usedToolNames?: Set<string>
        selectedSkillIds?: string[]
        autoSkillRouting?: boolean
    }
}

export interface ExecutionPlanInput {
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
    autoToolRouting?: boolean
    autoMemory?: boolean
    skillRouterProviderId?: string
    skillRouterModel?: string
    selectedToolKeys?: string[]
    hasExplicitToolAllowlist?: boolean
    usedToolNames?: Set<string>
    selectedSkillIds?: string[]
    autoSkillRouting?: boolean
}

export function toExecutionPlanInput(request: ExecutionRequest): ExecutionPlanInput {
    const run = request.run || {}
    return {
        resolvedAgent: request.resolvedAgent,
        conversationId: request.conversationId,
        broadcast: request.broadcast,
        abortSignal: request.abortSignal,
        gateway: request.gateway,
        toolRegistry: request.toolRegistry,
        messages: request.messages,
        userText: request.userText,
        providerOverride: run.providerOverride,
        modelOverride: run.modelOverride,
        systemPrompt: run.systemPrompt,
        systemPromptSuffix: run.systemPromptSuffix,
        requestedSubAgents: run.requestedSubAgents,
        memorySpaceOverrides: run.memorySpaceOverrides,
        autoToolRouting: run.autoToolRouting,
        autoMemory: run.autoMemory,
        skillRouterProviderId: run.skillRouterProviderId,
        skillRouterModel: run.skillRouterModel,
        selectedToolKeys: run.selectedToolKeys,
        hasExplicitToolAllowlist: run.hasExplicitToolAllowlist,
        usedToolNames: run.usedToolNames,
        selectedSkillIds: run.selectedSkillIds,
        autoSkillRouting: run.autoSkillRouting,
    }
}
