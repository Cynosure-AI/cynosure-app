import type { AgentData, SubAgentAssignment } from '../agents/agent-store.js'

export interface ExecutionPreset {
    id: string
    name?: string
    internalName?: string
    providerId?: string
    model?: string
    systemPrompt?: string
    tools: string[]
    skills?: string[]
    subAgents: SubAgentAssignment[]
    autoToolRouting?: boolean
    autoMemory?: boolean
    autoSkillRouting?: boolean
    autoRouterProviderId?: string
    autoRouterModel?: string
    toolRoutingEnabled?: boolean
    disableToolRouting?: boolean
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
        tools: overrides.tools ?? agent.tools,
        skills: agent.skills,
        subAgents: overrides.subAgents ?? agent.subAgents,
        autoToolRouting: agent.autoToolRouting,
        autoMemory: agent.autoMemory,
        autoSkillRouting: agent.autoSkillRouting,
        autoRouterProviderId: agent.autoRouterProviderId,
        autoRouterModel: agent.autoRouterModel,
    }
}

export function presetFromAgentless(options: {
    tools: string[]
    skills?: string[]
    subAgents?: SubAgentAssignment[]
    autoToolRouting: boolean
    autoMemory?: boolean
    autoSkillRouting?: boolean
    autoRouterProviderId?: string
    autoRouterModel?: string
}): ExecutionPreset {
    return {
        id: '__agentless__',
        name: 'Free Chat',
        internalName: 'free_chat',
        tools: options.tools,
        skills: options.skills ?? [],
        subAgents: options.subAgents ?? [],
        autoToolRouting: options.autoToolRouting,
        autoMemory: options.autoMemory,
        autoSkillRouting: options.autoSkillRouting,
        autoRouterProviderId: options.autoRouterProviderId,
        autoRouterModel: options.autoRouterModel,
    }
}
