import { applyAutoMemoryRouting } from './auto-memory-routing.js'
import type { ExecutionPreset } from '../execution-preset.js'
import type { LLMGateway } from '../../gateway/gateway.js'
import type { ChatMessage } from '../../gateway/providers/base.provider.js'
import type { MemorySpaceRef } from '../../memory/memory-space-scope.js'

export type ExecutionMemorySpaceRef = MemorySpaceRef

export interface ResolveMemoryContextInput {
    preset: ExecutionPreset
    conversationId: string
    gateway: LLMGateway
    providerId?: string
    model?: string
    autoMemory?: boolean
    memorySpaceOverrides?: ExecutionMemorySpaceRef[]
    userQuery?: string
    recentMessages?: ChatMessage[]
    /** Extra metadata to merge into emitted EventBus events during pre-execution routing. */
    eventMeta?: Record<string, unknown>
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
        gateway,
        providerId,
        model,
        autoMemory,
        memorySpaceOverrides,
        userQuery,
        recentMessages,
        eventMeta,
    } = input

    if (!isAutoMemoryEnabled(preset, autoMemory)) return []
    if (hasExplicitEmptyMemoryScope(memorySpaceOverrides)) return []

    const memoryContext = await applyAutoMemoryRouting({
        enabled: true,
        conversationId,
        userQuery,
        recentMessages,
        gateway,
        providerId,
        model,
        agentId: preset.id === '__agentless__' ? undefined : preset.id,
        memorySpaceIds: memorySpaceOverrides?.map((space) => space.id),
        eventMeta,
    })

    return memoryContext ? [{ role: 'system', content: memoryContext }] : []
}
