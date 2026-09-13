import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { interruptPlanningRun } from '../agent/planning-state.js'
import { cancelPostActions } from '../agent/post-execution.js'
import { trimMessagesToContextLimit, estimateTotalTokens, estimateToolDefinitionTokens } from '../agent/context-trimmer.js'
import { getEventBus } from '../telemetry/event-bus.js'
import { getChatAttachmentConfig } from '../chat/attachment-settings.js'
import { buildConversationHistory } from '../chat/message-history.js'
import { buildPersistedChatConfig } from '../chat/run-config.js'
import type { AgentData } from '../agents/agent-store.js'
import type { AgentExecutorResult } from '../agent/agent-executor.js'
import type { LLMGateway } from '../gateway/gateway.js'
import type { ChatMessage } from '../gateway/providers/base.provider.js'
import type { PlannedExecution } from '../agent/pre-execution/execution-planner.js'
import type { ActiveChannelExecutionEntry } from './base.channel.js'
import { artifactFileUrlToDataUrl, materializeAudioArtifacts, materializeImageArtifacts } from '../artifacts/image-artifacts.js'
import { getAssignedMemoryFolders } from '../memory/memory-folder-scope.js'

type BroadcastFn = (event: string, data: unknown) => void
export type ActiveChannelExecutionMap = Map<string, ActiveChannelExecutionEntry>

export function beginChannelExecution(input: {
    executions: ActiveChannelExecutionMap
    channelId: string
    agent: AgentData
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

export function buildChannelHistory(conversationId: string, agentId: string): {
    messages: ChatMessage[]
} {
    const db = getDb()
    return buildConversationHistory({
        db,
        conversationId,
        mainAgentId: agentId,
        inlineAttachmentTextLimit: getChatAttachmentConfig(db).inlineAttachmentTextLimit,
    })
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
    agent: AgentData
    messages: ChatMessage[]
}): Promise<{ messages: ChatMessage[]; contextWindow?: number; initialContextEstimate?: number }> {
    let contextWindow: number | undefined
    try {
        const info = await input.gateway.getModelInfo(input.planned.responseModel, input.planned.responseProvider)
        contextWindow = info.contextLength
    } catch { /* model metadata is best-effort */ }

    if (typeof input.agent.maxContextTokens === 'number' && input.agent.maxContextTokens > 0) {
        contextWindow = contextWindow
            ? Math.min(contextWindow, input.agent.maxContextTokens)
            : input.agent.maxContextTokens
    }
    if (!contextWindow) return { messages: input.messages }

    const initialContextEstimate = estimateTotalTokens(input.messages)
        + estimateToolDefinitionTokens(input.planned.tools)
    return {
        messages: trimMessagesToContextLimit(input.messages, contextWindow, {
            tools: input.planned.tools,
            thinkingEnabled: input.agent.thinkingEnabled !== false,
            reasoningEffort: input.agent.reasoningEffort,
        }),
        contextWindow,
        initialContextEstimate,
    }
}

export function persistChannelExecutionConfig(
    conversationId: string,
    agent: AgentData,
    planned: PlannedExecution,
): void {
    const config = buildPersistedChatConfig({
        selectedToolKeys: agent.tools || [],
        requestedSubAgents: agent.subAgents || [],
        requestedMemoryFolderIds: getAssignedMemoryFolders(agent.id).map((space) => space.id),
        systemPrompt: agent.systemPrompt,
        responseModel: planned.responseModel,
        responseProvider: planned.responseProvider,
        thinkingEnabled: agent.thinkingEnabled !== false,
        reasoningEffort: agent.reasoningEffort,
        autoToolRouting: agent.autoToolRouting === true,
        autoMemory: agent.autoMemory === true,
    })
    getDb().prepare('UPDATE conversations SET execution_config_json = ? WHERE id = ?')
        .run(JSON.stringify(config), conversationId)
}

export function persistChannelAssistantMessage(input: {
    conversationId: string
    agentId: string
    planned: PlannedExecution
    result: AgentExecutorResult
    startedAt: number
}): string {
    const db = getDb()
    const id = nanoid()
    const now = Date.now()
    db.prepare(
        `INSERT INTO messages (id, conversation_id, role, content, thinking, image_urls_json, generated_media, agent_id, provider, model, prompt_tokens, completion_tokens, context_tokens, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        id,
        input.conversationId,
        'assistant',
        input.result.content,
        input.result.thinking || null,
        input.result.images.length ? JSON.stringify(input.result.images) : null,
        input.result.images.length ? 1 : 0,
        input.agentId,
        input.planned.responseProvider,
        input.planned.responseModel,
        input.result.usage?.promptTokens ?? null,
        input.result.usage?.completionTokens ?? null,
        input.result.contextTokens ?? null,
        input.result.usage ? now - input.startedAt : null,
        now,
    )
    db.prepare('UPDATE conversations SET updated_at = ?, last_context_tokens = ? WHERE id = ?')
        .run(now, input.result.contextTokens ?? null, input.conversationId)
    return id
}
