import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { messageContentJson, messageToTranscriptItem, publishChatEvent } from '../chat/transcript.js'
import { persistAssistantTurn } from '../chat/persist-assistant.js'
import { interruptPlanningRun } from '../agent/planning-state.js'
import { cancelPostActions } from '../agent/post-execution.js'
import { applyContextStrategy } from '../agent/context-compactor.js'
import { getEventBus } from '../telemetry/event-bus.js'
import { resolveContextWindow } from '../chat/attachment-context.js'
import { buildConversationHistory, type BuiltChatHistory } from '../chat/message-history.js'
import type { RunSettings } from '../agent/run-settings.js'
import type { AgentExecutorResult } from '../agent/agent-executor.js'
import type { LLMGateway } from '../gateway/gateway.js'
import type { ChatMessage } from '../gateway/providers/base.provider.js'
import type { ContextStrategy, ConversationExecutionConfig } from '@shared/types'
import type { PlannedExecution } from '../agent/pre-execution/execution-planner.js'
import type { ActiveChannelExecutionEntry } from './base.channel.js'
import { artifactFileUrlToDataUrl, materializeAudioArtifacts, materializeImageArtifacts } from '../artifacts/image-artifacts.js'

type BroadcastFn = (event: string, data: unknown) => void
export type ActiveChannelExecutionMap = Map<string, ActiveChannelExecutionEntry>

export function persistChannelUserMessage(input: {
    broadcast: BroadcastFn
    conversationId: string
    messageId: string
    content: string
    images: string[]
    audio: string[]
    createdAt: number
}): void {
    const { broadcast, conversationId, messageId, content, images, audio, createdAt } = input
    const db = getDb()
    db.prepare(`INSERT INTO messages (id, conversation_id, role, content, content_blocks_json, created_at)
        VALUES (?, ?, 'user', ?, ?, ?)`).run(messageId, conversationId, content,
        messageContentJson({ id: messageId, content, imageDataUrls: images, audioDataUrls: audio }), createdAt)
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(createdAt, conversationId)
    publishChatEvent(broadcast, { conversationId, executionId: 'external', payload: {
        type: 'transcript-item', item: messageToTranscriptItem({
            id: messageId, role: 'user', content, imageDataUrls: images, audioDataUrls: audio, createdAt,
        }),
    } })
}

export function publishChannelStreamError(broadcast: BroadcastFn, conversationId: string, streamId: string, error: string): void {
    persistAssistantTurn(getDb(), broadcast, { conversationId, streamId, content: error, isError: true })
    publishChatEvent(broadcast, { conversationId, executionId: streamId, payload: {
        type: 'stream-error', streamId, scope: 'main', error,
    } })
}

export function beginChannelExecution(input: {
    executions: ActiveChannelExecutionMap
    channelId: string
    agent: { id: string; model: string | null }
    conversationId: string
    broadcast: BroadcastFn
}): { streamId: string; controller: AbortController } {
    const streamId = nanoid()
    const controller = new AbortController()
    input.executions.set(streamId, {
        exec: {
            id: streamId,
            channelId: input.channelId,
            agentId: input.agent.id,
            conversationId: input.conversationId,
            model: input.agent.model || null,
            startedAt: Date.now(),
        },
        controller,
    })
    input.broadcast('channel:conversation-state', {
        conversationId: input.conversationId,
        agentId: input.agent.id,
        running: true,
    })
    return { streamId, controller }
}

export function updateChannelExecution(
    executions: ActiveChannelExecutionMap,
    executionId: string,
    patch: { model?: string | null; planningRunId?: string },
): void {
    const entry = executions.get(executionId)
    if (!entry) return
    entry.exec = { ...entry.exec, ...patch }
}

export function cancelChannelExecution(
    executions: ActiveChannelExecutionMap,
    executionId: string,
): boolean {
    const entry = executions.get(executionId)
    if (!entry || entry.controller.signal.aborted) return false
    if (entry.exec.planningRunId) {
        interruptPlanningRun(entry.exec.planningRunId, { error: 'Interrupted before completion.' })
    }
    getEventBus().emit('hitl:clear-conversation', { conversationId: entry.exec.conversationId })
    cancelPostActions(entry.exec.conversationId)
    entry.controller.abort()
    return true
}

export function cancelChannelExecutionsWhere(
    executions: ActiveChannelExecutionMap,
    predicate: (entry: ActiveChannelExecutionEntry) => boolean,
): number {
    let cancelled = 0
    for (const [id, entry] of executions) {
        if (predicate(entry) && cancelChannelExecution(executions, id)) cancelled++
    }
    return cancelled
}

export function finishChannelExecution(input: {
    executions: ActiveChannelExecutionMap
    executionId: string
    conversationId: string
    agentId: string
    broadcast: BroadcastFn
}): void {
    input.executions.delete(input.executionId)
    input.broadcast('channel:conversation-state', {
        conversationId: input.conversationId,
        agentId: input.agentId,
        running: false,
    })
}

export function buildChannelHistory(conversationId: string, agentId: string | null, inlineAttachmentTextLimit: number): BuiltChatHistory {
    return buildConversationHistory({ db: getDb(), conversationId, mainAgentId: agentId, inlineAttachmentTextLimit })
}

export async function materializeChannelInputImages(
    imageDataUrls: string[],
    conversationId: string,
): Promise<string[]> {
    if (!imageDataUrls.length) return []
    try {
        const artifacts = await materializeImageArtifacts(imageDataUrls, conversationId)
        return artifacts.map((artifact) => artifact.url)
    } catch (err) {
        console.warn('[channels] Failed to materialize input images, retaining inline data:', err)
        return imageDataUrls
    }
}

export async function materializeChannelInputAudio(
    audioDataUrls: string[],
    conversationId: string,
): Promise<string[]> {
    if (!audioDataUrls.length) return []
    try {
        const artifacts = await materializeAudioArtifacts(audioDataUrls, conversationId)
        return artifacts.map((artifact) => artifact.url)
    } catch (err) {
        console.warn('[channels] Failed to materialize input audio, retaining inline data:', err)
        return audioDataUrls
    }
}

export function channelImageDataUrl(source: string): string | null {
    if (source.startsWith('data:image/')) return source
    return artifactFileUrlToDataUrl(source)
}

export async function applyChannelContextLimit(input: {
    gateway: LLMGateway
    planned: PlannedExecution
    settings: Pick<RunSettings, 'maxContextTokens' | 'thinkingEnabled' | 'reasoningEffort'>
    messages: ChatMessage[]
    history: BuiltChatHistory
    conversationId: string
    broadcast: BroadcastFn
    signal?: AbortSignal
}): Promise<{ messages: ChatMessage[]; contextWindow?: number; strategy?: ContextStrategy }> {
    const contextWindow = await resolveContextWindow({
        gateway: input.gateway,
        providerId: input.planned.responseProvider,
        model: input.planned.responseModel,
        maxContextTokens: input.settings.maxContextTokens,
    })
    // Without a known window, only a recorded compaction is applied.
    const fitted = await applyContextStrategy({
        messages: input.messages,
        historyRows: input.history.historyRows,
        filteredRows: input.history.filteredRows,
        contextWindow,
        tools: input.planned.tools,
        thinkingEnabled: input.settings.thinkingEnabled,
        reasoningEffort: input.settings.reasoningEffort,
        gateway: input.gateway,
        providerId: input.planned.providerId,
        responseModel: input.planned.responseModel,
        conversationId: input.conversationId,
        db: getDb(),
        broadcast: input.broadcast,
        signal: input.signal,
    })
    return {
        messages: fitted.messages,
        contextWindow,
        strategy: fitted.strategy,
    }
}

/** Record the settings a channel turn ran with. */
export function persistChannelExecutionConfig(conversationId: string, config: ConversationExecutionConfig): void {
    getDb().prepare('UPDATE conversations SET execution_config_json = ? WHERE id = ?')
        .run(JSON.stringify(config), conversationId)
}

export function persistChannelAssistantMessage(input: {
    broadcast: BroadcastFn
    conversationId: string
    streamId: string
    /** Null for Cyno. */
    agentId: string | null
    planned: PlannedExecution
    result: AgentExecutorResult
    startedAt: number
}): string {
    const db = getDb()
    // The shared path also publishes the transcript item, so open clients get the
    // saved reply and its streamed deltas can be pruned.
    const { id } = persistAssistantTurn(db, input.broadcast, {
        conversationId: input.conversationId, streamId: input.streamId,
        content: input.result.content, thinking: input.result.thinking,
        images: input.result.images, generatedMedia: input.result.images.length > 0,
        agentId: input.agentId, provider: input.planned.responseProvider, model: input.planned.responseModel,
        promptTokens: input.result.usage?.promptTokens, completionTokens: input.result.usage?.completionTokens,
        cacheReadTokens: input.result.usage?.cacheReadTokens, cacheWriteTokens: input.result.usage?.cacheWriteTokens,
        contextTokens: input.result.contextTokens, startedAt: input.result.usage ? input.startedAt : undefined,
    })
    db.prepare('UPDATE conversations SET last_context_tokens = ? WHERE id = ?')
        .run(input.result.contextTokens ?? null, input.conversationId)
    return id
}
