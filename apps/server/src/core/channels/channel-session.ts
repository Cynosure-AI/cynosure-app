/**
 * Platform-independent per-channel state and conversation bookkeeping.
 *
 * A "target" is the platform's conversation address inside one configured
 * channel: a Discord text channel, a Slack channel, or a Telegram chat.
 */
import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { getAgent, listAgents } from '../agents/agent-store.js'
import { getAssignedMemoryFolders } from '../memory/memory-folder-scope.js'
import { buildInitialExecutionConfig } from '../chat/run-config.js'
import { getEventBus } from '../telemetry/event-bus.js'
import { cancelChannelExecutionsWhere, type ActiveChannelExecutionMap } from './channel-execution.js'
import type { ChannelType } from './base.channel.js'

export type BroadcastFn = (event: string, data: unknown) => void
export type ChannelTargetId = string | number

export interface ChannelMedia {
    imageDataUrls: string[]
    audioDataUrls: string[]
}

export type ConversationSendFn = (fn: () => Promise<void>) => void

export interface ChannelSessionState<K extends ChannelTargetId> {
    readonly channelType: ChannelType
    channelId: string
    agentId: string
    broadcast: BroadcastFn
    allowedAgentIds: string[]
    activeExecutions: ActiveChannelExecutionMap
    /** Agent explicitly selected for a target via an agent command. */
    agentOverride: Map<K, string>
    /** Agent most recently used in a target; `new` continues with it. */
    lastUsedAgent: Map<K, string>
    /** Reverse lookup used to route HITL prompts and stop commands. */
    conversationTargets: Map<string, K>
    /** Serializes turns per target. */
    targetLocks: Map<K, Promise<void>>
    /** Media sent without text, held until the next text message. */
    pendingAttachments: Map<K, ChannelMedia>
    /** Ordered outbound queue of the running turn, so HITL prompts land after tool status lines. */
    conversationSendQueue: Map<string, ConversationSendFn>
}

/** Agents usable in this channel (all agents when no allow-list is configured). */
export function getAvailableAgents<K extends ChannelTargetId>(state: ChannelSessionState<K>) {
    const all = listAgents()
    if (state.allowedAgentIds.length === 0) return all
    const allowed = new Set(state.allowedAgentIds)
    return all.filter(a => allowed.has(a.id))
}

/** Command name an agent can be switched to with, e.g. `my-agent` → `my_agent`. */
export function agentCommandName(internalName: string): string {
    return internalName.toLowerCase().replace(/[^a-z0-9_]/g, '_')
}

export function effectiveAgentId<K extends ChannelTargetId>(state: ChannelSessionState<K>, target: K): string {
    return state.agentOverride.get(target) || state.agentId
}

function channelConversationKey<K extends ChannelTargetId>(state: ChannelSessionState<K>, target: K): string {
    return `${state.channelType}:${state.channelId}:${target}`
}

function findActiveConversation(channelKey: string, agentId: string): string | undefined {
    const row = getDb()
        .prepare("SELECT id FROM conversations WHERE origin = 'channel' AND agent_id = ? AND json_extract(metadata_json, '$.channelKey') = ? AND json_extract(metadata_json, '$.archived') IS NULL")
        .get(agentId, channelKey) as { id: string } | undefined
    return row?.id
}

export function getOrCreateChannelConversation<K extends ChannelTargetId>(
    state: ChannelSessionState<K>,
    target: K,
    senderName: string,
    agentId: string,
): string {
    const channelKey = channelConversationKey(state, target)
    const existing = findActiveConversation(channelKey, agentId)
    if (existing) return existing

    const id = nanoid()
    const now = Date.now()
    const agent = getAgent(agentId)
    const memoryFolderIds = getAssignedMemoryFolders(agentId).map((space) => space.id)
    const executionConfig = buildInitialExecutionConfig({ agent, memoryFolderIds })
    getDb().prepare(
        'INSERT INTO conversations (id, title, agent_id, origin, execution_config_json, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, senderName, agentId, 'channel', JSON.stringify(executionConfig), JSON.stringify({ channelKey }), now, now)
    return id
}

/** Archive the active conversation for a target so the next message starts a fresh one. */
export function archiveChannelConversation<K extends ChannelTargetId>(
    state: ChannelSessionState<K>,
    target: K,
    agentId: string,
): void {
    const existing = findActiveConversation(channelConversationKey(state, target), agentId)
    if (!existing) return
    getDb().prepare("UPDATE conversations SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.archived', ?), updated_at = ? WHERE id = ?")
        .run(Date.now(), Date.now(), existing)
    state.conversationTargets.delete(existing)
}

/** Cancel all running executions whose conversation belongs to the given target. */
export function cancelExecutionsForTarget<K extends ChannelTargetId>(state: ChannelSessionState<K>, target: K): number {
    return cancelChannelExecutionsWhere(state.activeExecutions, (entry) =>
        state.conversationTargets.get(entry.exec.conversationId) === target)
}

/** Run `fn` after every earlier turn for the same target has finished. */
export async function withTargetLock<K extends ChannelTargetId>(
    state: ChannelSessionState<K>,
    target: K,
    fn: () => Promise<void>,
): Promise<void> {
    const prev = state.targetLocks.get(target) || Promise.resolve()
    let unlock!: () => void
    const lock = new Promise<void>(resolve => { unlock = resolve })
    state.targetLocks.set(target, lock)
    await prev
    try {
        await fn()
    } finally {
        unlock()
        if (state.targetLocks.get(target) === lock) state.targetLocks.delete(target)
    }
}

// ─── Tool approval (HITL) ─────────────────────────────────

export interface ChannelHITLRequest {
    taskId: string
    conversationId: string
    toolCalls: { id: string; function: { name: string; arguments: string } }[]
    resolve: (result: { approved: boolean; reason?: string }) => void
}

/**
 * Forward HITL requests for this channel's conversations to `send`, ordered
 * after any pending output of the running turn. Returns an unsubscribe function.
 */
export function subscribeChannelHITL<K extends ChannelTargetId>(
    state: ChannelSessionState<K>,
    send: (request: ChannelHITLRequest, target: K, toolNames: string) => Promise<void>,
): () => void {
    return getEventBus().on('hitl:request', (...args: unknown[]) => {
        const request = args[0] as ChannelHITLRequest
        const target = state.conversationTargets.get(request.conversationId)
        if (target === undefined) return
        const toolNames = request.toolCalls.map(tc => `\`${tc.function.name}\``).join(', ')
        const deliver = () => send(request, target, toolNames).catch(() => { })
        const enqueue = state.conversationSendQueue.get(request.conversationId)
        if (enqueue) enqueue(deliver)
        else void deliver()
    })
}

/** Resolve a HITL request answered from a channel and notify the rest of the app. */
export function resolveChannelHITL(
    broadcast: BroadcastFn,
    pending: { conversationId: string; resolve: ChannelHITLRequest['resolve'] },
    taskId: string,
    approved: boolean,
    platformName: string,
): void {
    pending.resolve({ approved, reason: approved ? undefined : `Denied via ${platformName}` })
    broadcast('agent:hitl-resolved', { taskId, conversationId: pending.conversationId, approved })
    getEventBus().emit('hitl:resolved', { taskId, conversationId: pending.conversationId })
    try { getDb().prepare('DELETE FROM pending_hitl WHERE task_id = ?').run(taskId) } catch { /* best effort */ }
}

/** Parse a `hitl:<taskId>:<approve|deny>` button id. */
export function parseHITLActionId(id: string): { taskId: string; approved: boolean } | null {
    const [prefix, taskId, action] = id.split(':')
    if (prefix !== 'hitl' || !taskId) return null
    return { taskId, approved: action === 'approve' }
}
