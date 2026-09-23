import type { AgentData, SubAgentAssignment } from '../agents/agent-store.js'

export interface ExecutionPreset {
    id: string
    name?: string
    internalName?: string
    providerId?: string
    model?: string
    systemPrompt?: string
    tools: string[]
    subAgents: SubAgentAssignment[]
    autoToolRouting?: boolean
    autoMemory?: boolean
    autoRouterProviderId?: string
    autoRouterModel?: string
    toolRoutingEnabled?: boolean
    disableToolRouting?: boolean
}

/** Free chat's fixed agent definition. Each execution receives its own snapshot. */
export const DEFAULT_CHAT_AGENT = Object.freeze({
    id: '__agentless__',
    name: 'Free Chat',
    internalName: 'free_chat',
    tools: Object.freeze([] as string[]),
    subAgents: Object.freeze([] as SubAgentAssignment[]),
    autoToolRouting: false,
    autoMemory: false,
})

export function isDefaultChatAgent(preset: Pick<ExecutionPreset, 'id'>): boolean {
    return preset.id === DEFAULT_CHAT_AGENT.id
}

function snapshotSubAgents(subAgents: SubAgentAssignment[]): SubAgentAssignment[] {
    return subAgents.map(({ agentId }) => ({ agentId }))
}

export function presetFromAgent(
    agent: AgentData,
    overrides: {
        tools?: string[]
        subAgents?: SubAgentAssignment[]
    } = {},
): ExecutionPreset {
    return {
        id: agent.id,
        name: agent.name,
        internalName: agent.internalName,
        providerId: agent.providerId,
        model: agent.model,
        systemPrompt: agent.systemPrompt,
        tools: [...(overrides.tools ?? agent.tools)],
        subAgents: snapshotSubAgents(overrides.subAgents ?? agent.subAgents),
        autoToolRouting: agent.autoToolRouting,
        autoMemory: agent.autoMemory,
        autoRouterProviderId: agent.autoRouterProviderId,
        autoRouterModel: agent.autoRouterModel,
    }
}

export function presetFromAgentless(options: {
    tools: string[]
    subAgents?: SubAgentAssignment[]
    autoToolRouting: boolean
    autoMemory?: boolean
    autoRouterProviderId?: string
    autoRouterModel?: string
}): ExecutionPreset {
    return {
        ...DEFAULT_CHAT_AGENT,
        tools: [...options.tools],
        subAgents: snapshotSubAgents(options.subAgents ?? []),
        autoToolRouting: options.autoToolRouting,
        autoMemory: options.autoMemory,
        autoRouterProviderId: options.autoRouterProviderId,
        autoRouterModel: options.autoRouterModel,
    }
}

/** Resolve either chat mode to the same per-execution value object. */
export function snapshotChatExecutionPreset(
    agent: AgentData | null,
    options: {
        tools: string[]
        subAgents: SubAgentAssignment[]
        autoToolRouting: boolean
        autoMemory?: boolean
        autoRouterProviderId?: string
        autoRouterModel?: string
    },
): ExecutionPreset {
    return agent
        ? {
            ...presetFromAgent(agent, options),
            autoToolRouting: options.autoToolRouting,
            autoMemory: options.autoMemory ?? agent.autoMemory,
            autoRouterProviderId: options.autoRouterProviderId ?? agent.autoRouterProviderId,
            autoRouterModel: options.autoRouterModel ?? agent.autoRouterModel,
        }
        : presetFromAgentless(options)
}
