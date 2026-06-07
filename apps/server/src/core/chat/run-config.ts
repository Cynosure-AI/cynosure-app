import type Database from 'better-sqlite3'
import type { AgentData, SubAgentAssignment } from '../agents/agent-store.js'
import type { ToolRegistry } from '../tools/tool-registry.js'

export interface ToolSelectionConfig {
    selectedToolKeys: string[]
    hasExplicitToolAllowlist: boolean
}

export interface EffectiveChatRunFlags {
    autoMemory: boolean
    autoSkillRouting: boolean
}

export interface PersistedChatConfigInput {
    selectedToolKeys: string[]
    routedToolKeys: string[]
    requestedSubAgents?: SubAgentAssignment[]
    requestedMemorySpaceIds?: string[]
    systemPrompt?: string
    responseModel: string
    responseProvider: string
    thinkingEnabled: boolean
    autoToolRouting: boolean
    autoMemory: boolean
    selectedSkillIds: string[]
    autoSkillRouting: boolean
}

export function resolveToolSelection(
    toolRegistry: ToolRegistry,
    allowedTools?: string[],
    autoToolRouting?: boolean,
): ToolSelectionConfig {
    const selectedToolKeys = Array.isArray(allowedTools)
        ? Array.from(new Set(allowedTools)).filter((name) => toolRegistry.hasKey(name))
        : []

    return {
        selectedToolKeys,
        hasExplicitToolAllowlist: Array.isArray(allowedTools) && autoToolRouting !== true,
    }
}

export function resolveChatRunFlags(input: {
    resolvedAgent: AgentData | null
    autoMemory?: boolean
    autoSkillRouting?: boolean
}): EffectiveChatRunFlags {
    const { resolvedAgent, autoMemory, autoSkillRouting } = input
    return {
        autoMemory: autoMemory !== undefined
            ? autoMemory === true
            : (resolvedAgent?.autoMemory === true),
        autoSkillRouting: autoSkillRouting !== undefined
            ? autoSkillRouting === true
            : (resolvedAgent?.autoSkillRouting !== false),
    }
}

export function resolveMemorySpaceOverrides(
    db: Database.Database,
    requestedSpaceIds?: string[],
): { id: string; name: string }[] | undefined {
    if (!Array.isArray(requestedSpaceIds)) return undefined

    const uniqueSpaceIds = Array.from(new Set(requestedSpaceIds.map((sid) => sid.trim()).filter(Boolean)))
    return uniqueSpaceIds
        .map((sid) => db.prepare('SELECT id, name FROM memory_spaces WHERE id = ?').get(sid) as { id: string; name: string } | undefined)
        .filter((row): row is { id: string; name: string } => Boolean(row))
}

export function buildPersistedChatConfig(input: PersistedChatConfigInput): Record<string, unknown> {
    return {
        allowedTools: input.autoToolRouting ? input.routedToolKeys : input.selectedToolKeys,
        subAgents: input.requestedSubAgents ?? [],
        memorySpaceIds: input.requestedMemorySpaceIds ?? [],
        systemPrompt: input.systemPrompt || '',
        model: input.responseModel,
        providerId: input.responseProvider,
        thinkingEnabled: input.thinkingEnabled,
        autoToolRouting: input.autoToolRouting,
        autoMemory: input.autoMemory,
        selectedSkillIds: input.selectedSkillIds,
        autoSkillRouting: input.autoSkillRouting,
    }
}
