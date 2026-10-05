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
}

/** Free chat's fixed agent definition. Each execution receives its own snapshot. */
export const DEFAULT_CHAT_AGENT = Object.freeze({
    id: '__agentless__',
    name: 'Free Chat',
    internalName: 'free_chat',
    tools: Object.freeze([] as string[]),
    subAgents: Object.freeze([] as SubAgentAssignment[]),
    autoToolRouting: true,
    autoMemory: true,
})

/** Auto-mode defaults when a run does not specify them: the agent's saved settings, or Free Chat's. */
export function defaultAutoModes(
    agent: Pick<AgentData, 'autoToolRouting' | 'autoMemory'> | null | undefined,
): { autoToolRouting: boolean; autoMemory: boolean } {
    return agent
        ? { autoToolRouting: agent.autoToolRouting === true, autoMemory: agent.autoMemory === true }
        : { autoToolRouting: DEFAULT_CHAT_AGENT.autoToolRouting, autoMemory: DEFAULT_CHAT_AGENT.autoMemory }
}

export function isDefaultChatAgent(preset: Pick<ExecutionPreset, 'id'>): boolean {
    return preset.id === DEFAULT_CHAT_AGENT.id
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
    const base = agent
        ? {
            id: agent.id,
            name: agent.name,
            internalName: agent.internalName,
            providerId: agent.providerId,
            model: agent.model,
            systemPrompt: agent.systemPrompt,
        }
        : DEFAULT_CHAT_AGENT
    return {
        ...base,
        tools: [...options.tools],
        subAgents: options.subAgents.map(({ agentId }) => ({ agentId })),
        autoToolRouting: options.autoToolRouting,
        autoMemory: options.autoMemory ?? agent?.autoMemory,
        autoRouterProviderId: options.autoRouterProviderId ?? agent?.autoRouterProviderId,
        autoRouterModel: options.autoRouterModel ?? agent?.autoRouterModel,
    }
}
