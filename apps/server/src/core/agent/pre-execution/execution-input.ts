import type { AgentData, SubAgentAssignment } from '../../agents/agent-store.js'
import type { LLMGateway } from '../../gateway/gateway.js'
import type { ChatMessage } from '../../gateway/providers/base.provider.js'
import type { MemorySpaceRef } from '../../memory/memory-space-scope.js'
import type { ToolRegistry } from '../../tools/tool-registry.js'
import type { ReasoningEffort } from '@shared/types'

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
        memorySpaceOverrides?: MemorySpaceRef[]
        autoToolRouting?: boolean
        autoMemory?: boolean
        autoRouterProviderId?: string
        autoRouterModel?: string
        selectedToolKeys?: string[]
        hasExplicitToolAllowlist?: boolean
        usedToolNames?: Set<string>
        thinkingEnabled?: boolean
        reasoningEffort?: ReasoningEffort
        inlineAttachmentTextLimit?: number
        debugContextEnabled?: boolean
    }
    /** Extra metadata to merge into emitted EventBus events during pre-execution routing (e.g. maCodename for sub-agents). */
    eventMeta?: Record<string, unknown>
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
    memorySpaceOverrides?: MemorySpaceRef[]
    autoToolRouting?: boolean
    autoMemory?: boolean
    autoRouterProviderId?: string
    autoRouterModel?: string
    selectedToolKeys?: string[]
    hasExplicitToolAllowlist?: boolean
    usedToolNames?: Set<string>
    thinkingEnabled?: boolean
    eventMeta?: Record<string, unknown>
    inlineAttachmentTextLimit?: number
    debugContextEnabled?: boolean
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
        autoRouterProviderId: run.autoRouterProviderId,
        autoRouterModel: run.autoRouterModel,
        selectedToolKeys: run.selectedToolKeys,
        hasExplicitToolAllowlist: run.hasExplicitToolAllowlist,
        usedToolNames: run.usedToolNames,
        thinkingEnabled: run.thinkingEnabled,
        eventMeta: request.eventMeta,
        inlineAttachmentTextLimit: run.inlineAttachmentTextLimit,
        debugContextEnabled: run.debugContextEnabled,
    }
}
