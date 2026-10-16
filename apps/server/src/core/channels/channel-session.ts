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
import { CYNO_AGENT_ID, isCyno } from '../agent/execution-preset.js'
import { getCynoProfile } from '../cyno/cyno-profile.js'
import { cynoExecutionConfig } from '../cyno/cyno-run.js'
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
    /** A chat whose last user message is older than this starts over; 0 keeps chats until `new`. */
    sessionIdleMs: number
}

/** Default of the `sessionIdleHours` channel setting. */
export const DEFAULT_SESSION_IDLE_HOURS = 4

/** Idle limit from persisted channel config; a missing or invalid value uses the default. */
export function sessionIdleMsFromConfig(config: { sessionIdleHours?: unknown }): number {
    const hours = Number(config.sessionIdleHours ?? DEFAULT_SESSION_IDLE_HOURS)
    return (Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_SESSION_IDLE_HOURS) * 3_600_000
}

/** Agents usable in this channel (all agents when no allow-list is configured). */
export function getAvailableAgents<K extends ChannelTargetId>(state: ChannelSessionState<K>) {
    const all = listAgents()
    if (state.allowedAgentIds.length === 0) return all
    const allowed = new Set(state.allowedAgentIds)
    return all.filter(a => allowed.has(a.id))
}

/** Display name of the agent a channel target talks to. */
export function channelAgentName(agentId: string): string {
    return isCyno(agentId) ? getCynoProfile().name : (getAgent(agentId)?.name || 'Unknown')
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

interface ActiveConversation {
    id: string
    projectId: string | null
    /** Last user message, or creation when the user has not written yet. Proactive messages do not count. */
    lastActiveAt: number
}

function findActiveConversation(channelKey: string, agentId: string): ActiveConversation | undefined {
    return getDb()
        .prepare(`SELECT c.id, c.project_id AS projectId,
                COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user'), c.created_at) AS lastActiveAt
            FROM conversations c
            WHERE c.origin = 'channel' AND c.agent_id IS ? AND json_extract(c.metadata_json, '$.channelKey') = ? AND json_extract(c.metadata_json, '$.archived') IS NULL`)
        .get(isCyno(agentId) ? null : agentId, channelKey) as ActiveConversation | undefined
}

/** The chat has been idle past the channel's limit and no turn of it is still running. */
function isIdleExpired<K extends ChannelTargetId>(state: ChannelSessionState<K>, conversation: ActiveConversation): boolean {
    if (state.sessionIdleMs <= 0 || Date.now() - conversation.lastActiveAt <= state.sessionIdleMs) return false
    for (const entry of state.activeExecutions.values()) {
        if (entry.exec.conversationId === conversation.id) return false
    }
    return true
}

function archiveConversation<K extends ChannelTargetId>(state: ChannelSessionState<K>, conversationId: string): void {
    getDb().prepare("UPDATE conversations SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.archived', ?), updated_at = ? WHERE id = ?")
        .run(Date.now(), Date.now(), conversationId)
    state.conversationTargets.delete(conversationId)
}

export function getOrCreateChannelConversation<K extends ChannelTargetId>(
    state: ChannelSessionState<K>,
    target: K,
    senderName: string,
    agentId: string,
): string {
    const channelKey = channelConversationKey(state, target)
    const existing = findActiveConversation(channelKey, agentId)
    if (existing && !isIdleExpired(state, existing)) return existing.id
    // An idle chat ends on its own; the project it worked in carries over.
    if (existing) archiveConversation(state, existing.id)

    const id = nanoid()
    const now = Date.now()
    const cyno = isCyno(agentId)
    const executionConfig = cyno
        ? cynoExecutionConfig()
        : buildInitialExecutionConfig({
            agent: getAgent(agentId),
            memoryFolderIds: getAssignedMemoryFolders(agentId).map((space) => space.id),
        })
    getDb().prepare(
        'INSERT INTO conversations (id, title, agent_id, origin, execution_config_json, metadata_json, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, senderName, cyno ? null : agentId, 'channel', JSON.stringify(executionConfig), JSON.stringify({ channelKey }), existing?.projectId ?? null, now, now)
    return id
}

/** The conversation the target's next message would continue: the active one with its current agent. */
export function resolveHomeConversation<K extends ChannelTargetId>(
    state: ChannelSessionState<K>,
    target: K,
): { conversationId: string; agentId: string } {
    const agentId = effectiveAgentId(state, target)
    const conversationId = getOrCreateChannelConversation(state, target, 'Channel chat', agentId)
    state.conversationTargets.set(conversationId, target)
    return { conversationId, agentId }
}

/**
 * The target's active conversation with its current agent while it has not
 * gone idle, without starting one. Proactive messages join this chat only.
 */
export function findHomeConversation<K extends ChannelTargetId>(
    state: ChannelSessionState<K>,
    target: K,
): { conversationId: string; agentId: string } | null {
    const agentId = effectiveAgentId(state, target)
    const existing = findActiveConversation(channelConversationKey(state, target), agentId)
    if (!existing || isIdleExpired(state, existing)) return null
    state.conversationTargets.set(existing.id, target)
    return { conversationId: existing.id, agentId }
}

/**
 * A conversation a channel message continues explicitly, such as a scheduled
 * run the user replied to. It keeps its own agent (Cyno when it has none) when
 * that agent is usable on this channel; otherwise `agentId` is null and the
 * target's current agent takes over.
 */
export function resolveContinuedConversation<K extends ChannelTargetId>(
    state: ChannelSessionState<K>,
    conversationId: string,
): { conversationId: string; agentId: string | null } | null {
    const row = getDb().prepare('SELECT id, agent_id FROM conversations WHERE id = ?')
        .get(conversationId) as { id: string; agent_id: string | null } | undefined
    if (!row) return null
    if (!row.agent_id) return { conversationId: row.id, agentId: CYNO_AGENT_ID }
    const ownAgentUsable = getAvailableAgents(state).some((agent) => agent.id === row.agent_id)
    return { conversationId: row.id, agentId: ownAgentUsable ? row.agent_id : null }
}

/** Archive the active conversation for a target so the next message starts a fresh one. */
export function archiveChannelConversation<K extends ChannelTargetId>(
    state: ChannelSessionState<K>,
    target: K,
    agentId: string,
): void {
    const existing = findActiveConversation(channelConversationKey(state, target), agentId)
    if (existing) archiveConversation(state, existing.id)
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
