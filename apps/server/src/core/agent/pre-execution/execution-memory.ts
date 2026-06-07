import { applyAutoMemoryRouting } from './auto-memory-routing.js'
import type { ExecutionPreset } from '../execution-preset.js'
import type { ChatMessage } from '../../gateway/providers/base.provider.js'

export type ExecutionMemorySpaceRef = { id: string; name: string }

export interface ResolveMemoryContextInput {
    preset: ExecutionPreset
    conversationId: string
    autoMemory?: boolean
    memorySpaceOverrides?: ExecutionMemorySpaceRef[]
    userQuery?: string
    recentMessages?: ChatMessage[]
}

export function isAutoMemoryEnabled(preset: ExecutionPreset, sessionEnabled?: boolean): boolean {
    if (sessionEnabled === true) return true
    if (sessionEnabled === false) return false
    return preset.autoMemory === true
}

export function isRuntimeMemoryEnabled(
    preset: ExecutionPreset,
    sessionEnabled: boolean | undefined,
    memorySpaceOverrides: ExecutionMemorySpaceRef[] | undefined,
): boolean {
    if (hasExplicitEmptyMemoryScope(memorySpaceOverrides)) return false
    return Boolean(memorySpaceOverrides?.length) || isAutoMemoryEnabled(preset, sessionEnabled)
}

export function hasExplicitEmptyMemoryScope(
    memorySpaceOverrides: ExecutionMemorySpaceRef[] | undefined,
): boolean {
    return Array.isArray(memorySpaceOverrides) && memorySpaceOverrides.length === 0
}

export async function resolveMemorySystemMessages(input: ResolveMemoryContextInput): Promise<ChatMessage[]> {
    const {
        preset,
        conversationId,
        autoMemory,
        memorySpaceOverrides,
        userQuery,
        recentMessages,
    } = input

    if (!isAutoMemoryEnabled(preset, autoMemory)) return []
    if (hasExplicitEmptyMemoryScope(memorySpaceOverrides)) return []

    const memoryContext = await applyAutoMemoryRouting({
        enabled: true,
        conversationId,
        userQuery,
        recentMessages,
        agentId: preset.id === '__agentless__' ? undefined : preset.id,
        memorySpaceIds: memorySpaceOverrides?.map((space) => space.id),
    })

    return memoryContext ? [{ role: 'system', content: memoryContext }] : []
}
