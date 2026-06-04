import type { AgentData, SubAgentAssignment } from '../agents/agent-store.js'

export interface ExecutionPreset {
    id: string
    providerId?: string
    model?: string
    systemPrompt?: string
    tools: string[]
    skills?: string[]
    subAgents: SubAgentAssignment[]
    autoToolRouting?: boolean
    toolRouterProviderId?: string
    toolRouterModel?: string
    autoMemory?: boolean
    memoryRouterProviderId?: string
    memoryRouterModel?: string
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
        providerId: agent.providerId,
        model: agent.model,
        systemPrompt: agent.systemPrompt,
        tools: overrides.tools ?? agent.tools,
        skills: agent.skills,
        subAgents: overrides.subAgents ?? agent.subAgents,
        autoToolRouting: agent.autoToolRouting,
        toolRouterProviderId: agent.toolRouterProviderId,
        toolRouterModel: agent.toolRouterModel,
        autoMemory: agent.autoMemory,
        memoryRouterProviderId: agent.memoryRouterProviderId,
        memoryRouterModel: agent.memoryRouterModel,
    }
}

export function presetFromAgentless(options: {
    tools: string[]
    skills?: string[]
    subAgents?: SubAgentAssignment[]
    autoToolRouting: boolean
    toolRouterProviderId?: string
    toolRouterModel?: string
    autoMemory?: boolean
    memoryRouterProviderId?: string
    memoryRouterModel?: string
}): ExecutionPreset {
    return {
        id: '__agentless__',
        tools: options.tools,
        skills: options.skills ?? [],
        subAgents: options.subAgents ?? [],
        autoToolRouting: options.autoToolRouting,
        toolRouterProviderId: options.toolRouterProviderId,
        toolRouterModel: options.toolRouterModel,
        autoMemory: options.autoMemory,
        memoryRouterProviderId: options.memoryRouterProviderId,
        memoryRouterModel: options.memoryRouterModel,
    }
}
