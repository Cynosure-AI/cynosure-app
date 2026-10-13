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

/**
 * Agent id that stands for Cyno, which runs without an agent. Cyno's
 * conversations, channel chats, and jobs store no agent id at all.
 */
export const CYNO_AGENT_ID = '__agentless__'

/** Cyno's fixed run identity. Its settings come from the Cyno profile. */
export const CYNO_PRESET = Object.freeze({
    id: CYNO_AGENT_ID,
    name: 'Cyno',
    internalName: 'cyno',
    tools: Object.freeze([] as string[]),
    subAgents: Object.freeze([] as SubAgentAssignment[]),
    autoToolRouting: true,
    autoMemory: true,
})

/** Auto-mode defaults when a run does not specify them: the agent's saved settings, or Cyno's. */
export function defaultAutoModes(
    agent: Pick<AgentData, 'autoToolRouting' | 'autoMemory'> | null | undefined,
): { autoToolRouting: boolean; autoMemory: boolean } {
    return agent
        ? { autoToolRouting: agent.autoToolRouting === true, autoMemory: agent.autoMemory === true }
        : { autoToolRouting: CYNO_PRESET.autoToolRouting, autoMemory: CYNO_PRESET.autoMemory }
}

/** Whether an agent id (or preset) means Cyno: no id, an empty id, or Cyno's id. */
export function isCyno(agent: string | Pick<ExecutionPreset, 'id'> | null | undefined): boolean {
    const id = typeof agent === 'object' && agent !== null ? agent.id : agent
    return !id || id === CYNO_AGENT_ID
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
        : CYNO_PRESET
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
