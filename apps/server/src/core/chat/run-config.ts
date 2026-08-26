import type Database from 'better-sqlite3'
import type { AgentData, SubAgentAssignment } from '../agents/agent-store.js'
import type { ToolRegistry } from '../tools/tool-registry.js'
import type { ConversationExecutionConfig, ReasoningEffort } from '@shared/types'
import { relativePathForFolder } from '../memory/memory-space-folders.js'
import type { MemorySpaceRef } from '../memory/memory-space-scope.js'

export interface ToolSelectionConfig {
    selectedToolKeys: string[]
    hasExplicitToolAllowlist: boolean
}

export interface EffectiveChatRunFlags {
    autoMemory: boolean
}

export interface PersistedChatConfigInput {
    selectedToolKeys: string[]
    requestedSubAgents?: SubAgentAssignment[]
    requestedMemorySpaceIds?: string[]
    systemPrompt?: string
    responseModel: string
    responseProvider: string
    thinkingEnabled: boolean
    reasoningEffort?: ReasoningEffort
    autoToolRouting: boolean
    autoMemory: boolean
}

const REASONING_EFFORTS = new Set<ReasoningEffort>([
    'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
])

function parseReasoningEffort(value: unknown): ReasoningEffort {
    return typeof value === 'string' && REASONING_EFFORTS.has(value as ReasoningEffort)
        ? value as ReasoningEffort
        : 'medium'
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
}): EffectiveChatRunFlags {
    const { resolvedAgent, autoMemory } = input
    return {
        autoMemory: autoMemory !== undefined
            ? autoMemory === true
            : (resolvedAgent?.autoMemory === true),
    }
}

export function resolveMemorySpaceOverrides(
    db: Database.Database,
    requestedSpaceIds?: string[],
): MemorySpaceRef[] | undefined {
    if (!Array.isArray(requestedSpaceIds)) return undefined

    const uniqueSpaceIds = Array.from(new Set(requestedSpaceIds.map((sid) => sid.trim()).filter(Boolean)))
    return uniqueSpaceIds
        .map((sid) => db.prepare('SELECT id, name, folder_path, is_default FROM memory_spaces WHERE id = ?').get(sid) as { id: string; name: string; folder_path: string; is_default: number } | undefined)
        .filter((row): row is { id: string; name: string; folder_path: string; is_default: number } => Boolean(row))
        .map((row) => ({
            id: row.id,
            name: row.name,
            relativePath: row.is_default === 1 ? '' : relativePathForFolder(row.folder_path),
        }))
}

export function buildPersistedChatConfig(input: PersistedChatConfigInput): ConversationExecutionConfig {
    return {
        allowedTools: input.selectedToolKeys,
        subAgents: input.requestedSubAgents ?? [],
        memorySpaceIds: input.requestedMemorySpaceIds ?? [],
        systemPrompt: input.systemPrompt || '',
        model: input.responseModel,
        providerId: input.responseProvider,
        thinkingEnabled: input.thinkingEnabled,
        reasoningEffort: input.reasoningEffort ?? 'medium',
        autoToolRouting: input.autoToolRouting,
        autoMemory: input.autoMemory,
    }
}

export function buildInitialExecutionConfig(input: {
    agent?: AgentData | null
    memorySpaceIds?: string[]
} = {}): ConversationExecutionConfig {
    const agent = input.agent ?? null
    return {
        allowedTools: agent?.tools ? [...agent.tools] : [],
        subAgents: agent?.subAgents ? [...agent.subAgents] : [],
        memorySpaceIds: input.memorySpaceIds ?? [],
        systemPrompt: agent?.systemPrompt ?? '',
        model: agent?.model ?? '',
        providerId: agent?.providerId ?? '',
        thinkingEnabled: agent?.thinkingEnabled !== false,
        reasoningEffort: agent?.reasoningEffort ?? 'medium',
        autoToolRouting: agent?.autoToolRouting === true,
        autoMemory: agent?.autoMemory === true,
    }
}

export function parseExecutionConfig(raw: string | null | undefined): ConversationExecutionConfig {
    if (!raw) return buildInitialExecutionConfig()
    const parsed = JSON.parse(raw) as Partial<ConversationExecutionConfig>
    return {
        allowedTools: Array.isArray(parsed.allowedTools) ? parsed.allowedTools.filter((value): value is string => typeof value === 'string') : [],
        subAgents: Array.isArray(parsed.subAgents)
            ? parsed.subAgents.filter((value): value is SubAgentAssignment => (
                Boolean(value) && typeof value === 'object' && typeof value.agentId === 'string'
            ))
            : [],
        memorySpaceIds: Array.isArray(parsed.memorySpaceIds) ? parsed.memorySpaceIds.filter((value): value is string => typeof value === 'string') : [],
        systemPrompt: typeof parsed.systemPrompt === 'string' ? parsed.systemPrompt : '',
        model: typeof parsed.model === 'string' ? parsed.model : '',
        providerId: typeof parsed.providerId === 'string' ? parsed.providerId : '',
        thinkingEnabled: parsed.thinkingEnabled !== false,
        reasoningEffort: parseReasoningEffort(parsed.reasoningEffort),
        autoToolRouting: parsed.autoToolRouting === true,
        autoMemory: parsed.autoMemory === true,
        ...(typeof parsed.autoRouterProviderId === 'string' ? { autoRouterProviderId: parsed.autoRouterProviderId } : {}),
        ...(typeof parsed.autoRouterModel === 'string' ? { autoRouterModel: parsed.autoRouterModel } : {}),
    }
}
