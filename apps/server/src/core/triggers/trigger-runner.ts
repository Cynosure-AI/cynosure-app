import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { getGateway } from '../gateway/gateway.js'
import { getEventBus } from '../telemetry/event-bus.js'
import { AgentExecutor, MAIN_AGENT_MAX_ROUNDS, type AgentExecutorResult } from '../agent/agent-executor.js'
import { planExecution } from '../agent/pre-execution/execution-planner.js'
import { closePlanningRun } from '../agent/planning-state.js'
import { getToolRegistry } from '../tools/tool-registry.js'
import type { AgentData } from '../agents/agent-store.js'
import type { ChatMessage } from '../gateway/providers/base.provider.js'
import { getAssignedMemoryFolderIds, getAssignedMemoryFolders } from '../memory/memory-folder-scope.js'
import { buildPersistedChatConfig } from '../chat/run-config.js'
import { resolveMemoryFolderOverrides } from '../chat/run-config.js'
import { messageContentJson, messageToTranscriptItem, publishChatEvent } from '../chat/transcript.js'
import { persistAssistantTurn } from '../chat/persist-assistant.js'
import type { ConversationExecutionConfig } from '@shared/types'

type BroadcastFn = (event: string, data: unknown) => void

export interface TriggerRunConfig {
    /** Agent definition (from getAgent) */
    agent: AgentData | null
    /** Frozen Free Chat configuration for an agentless trigger. */
    executionConfig?: ConversationExecutionConfig
    /** User message content for this trigger execution */
    userContent: string
    /** Conversation origin label (e.g. 'cron') */
    origin: string
    /** Conversation title */
    title: string
    /** Suffix appended to the agent's system prompt */
    systemPromptSuffix: string
    /** WebSocket broadcast function */
    broadcast: BroadcastFn
    /** Abort signal for cancellation */
    signal: AbortSignal
    /** Log prefix for console messages (e.g. '[cron]') */
    logPrefix: string
    /** Called as soon as the conversation is created, before execution starts */
    onConversationCreated?: (conversationId: string) => void
}

export interface TriggerRunResult {
    conversationId: string
    result: AgentExecutorResult
}

/**
 * Shared orchestration for trigger-based agent executions.
 *
 * Creates a conversation, prepares the execution context, runs the agent
 * executor, saves messages, and returns the result. The caller is responsible
 * for managing abort controllers and active-run tracking.
 */
export async function runTriggerExecution(config: TriggerRunConfig): Promise<TriggerRunResult> {
    const { agent, executionConfig, userContent, origin, title, systemPromptSuffix, broadcast, signal, logPrefix, onConversationCreated } = config
    if (!agent && !executionConfig) throw new Error('Trigger execution requires an agent or an execution configuration')
    const gateway = getGateway()
    const db = getDb()

    // Create conversation
    const conversationId = nanoid()
    db.prepare(
        'INSERT INTO conversations (id, title, agent_id, origin, execution_config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(conversationId, title, agent?.id ?? null, origin, JSON.stringify(executionConfig ?? {}), Date.now(), Date.now())

    // Notify the caller and persist the trigger input before any fallible
    // context preparation. Failed/cancelled pre-turn work must still leave a
    // coherent conversation that explains what was attempted.
    onConversationCreated?.(conversationId)
    const triggerMsgId = nanoid()
    const triggerCreatedAt = Date.now()
    db.prepare(
        'INSERT INTO messages (id, conversation_id, role, content, content_blocks_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(triggerMsgId, conversationId, 'user', userContent,
        messageContentJson({ id: triggerMsgId, content: userContent }), triggerCreatedAt)
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(triggerCreatedAt, conversationId)

    publishChatEvent(broadcast, { conversationId, executionId: 'external', payload: {
        type: 'transcript-item', item: messageToTranscriptItem({
            id: triggerMsgId, role: 'user', content: userContent, createdAt: triggerCreatedAt,
        }),
    } })

    const startMs = Date.now()
    let planningRunId: string | undefined

    try {
        const memoryFolders = agent
            ? getAssignedMemoryFolders(agent.id)
            : (resolveMemoryFolderOverrides(db, executionConfig?.memoryFolderIds) ?? [])
        const planned = await planExecution({
            resolvedAgent: agent,
            conversationId,
            broadcast,
            abortSignal: signal,
            gateway,
            toolRegistry: getToolRegistry(),
            messages: [{ role: 'user', content: userContent }],
            userText: userContent,
            run: {
                systemPromptSuffix,
                providerOverride: executionConfig?.providerId || undefined,
                modelOverride: executionConfig?.model || undefined,
                systemPrompt: executionConfig?.systemPrompt,
                requestedSubAgents: executionConfig?.subAgents,
                selectedToolKeys: executionConfig?.allowedTools,
                hasExplicitToolAllowlist: executionConfig ? executionConfig.autoToolRouting !== true : undefined,
                memoryFolderOverrides: memoryFolders,
                autoToolRouting: executionConfig?.autoToolRouting ?? (agent?.autoToolRouting === true),
                autoMemory: executionConfig?.autoMemory ?? (agent?.autoMemory === true),
                autoRouterProviderId: executionConfig?.autoRouterProviderId,
                autoRouterModel: executionConfig?.autoRouterModel,
                thinkingEnabled: executionConfig?.thinkingEnabled ?? (agent?.thinkingEnabled !== false),
                reasoningEffort: executionConfig?.reasoningEffort ?? agent?.reasoningEffort,
            },
        })
        planningRunId = planned.planningRunId

        const persistedExecutionConfig = buildPersistedChatConfig({
            selectedToolKeys: executionConfig?.allowedTools ?? agent?.tools ?? [],
            requestedSubAgents: executionConfig?.subAgents ?? agent?.subAgents ?? [],
            requestedMemoryFolderIds: executionConfig?.memoryFolderIds ?? (agent ? getAssignedMemoryFolderIds(agent.id, db) : []),
            // The planner appends trigger instructions and runtime context to its
            // prompt. Only the editable base prompt belongs in session settings.
            systemPrompt: executionConfig?.systemPrompt ?? agent?.systemPrompt ?? '',
            responseModel: planned.responseModel,
            responseProvider: planned.responseProvider,
            thinkingEnabled: executionConfig?.thinkingEnabled ?? (agent?.thinkingEnabled !== false),
            reasoningEffort: executionConfig?.reasoningEffort ?? agent?.reasoningEffort,
            autoToolRouting: executionConfig?.autoToolRouting ?? (agent?.autoToolRouting === true),
            autoMemory: executionConfig?.autoMemory ?? (agent?.autoMemory === true),
        })
        db.prepare('UPDATE conversations SET execution_config_json = ? WHERE id = ?').run(JSON.stringify(persistedExecutionConfig), conversationId)

        const messages: ChatMessage[] = planned.messages
        const executor = new AgentExecutor({
            gateway,
            tools: planned.tools,
            conversationId,
            broadcast,
            providerId: planned.providerId,
            model: planned.responseModel,
            maxRounds: MAIN_AGENT_MAX_ROUNDS,
            thinkingEnabled: executionConfig?.thinkingEnabled ?? (agent?.thinkingEnabled !== false),
            reasoningEffort: executionConfig?.reasoningEffort ?? agent?.reasoningEffort,
            streamMode: 'per-round',
            hitl: agent ? !agent.autoApproveTools : true,
            agentId: agent?.id,
            agentName: agent?.name,
            agentIconUrl: agent?.iconUrl || null,
            signal,
            planningRunId,
            isPrimaryExecutor: true,
        })
        const result = await executor.run(messages)
        signal.throwIfAborted()
        if (planningRunId) {
            closePlanningRun(planningRunId, 'completed', { summary: result.content.slice(0, 500) })
        }

        // Publish the saved identity for the final per-round stream as well as
        // storing it, so history loading and event replay join the same reply.
        persistAssistantTurn(db, broadcast, {
            conversationId, streamId: executor.lastStreamId,
            content: result.content, thinking: result.thinking, images: result.images,
            provider: planned.providerId, model: planned.responseModel,
            promptTokens: result.usage?.promptTokens, completionTokens: result.usage?.completionTokens,
            contextTokens: result.contextTokens, startedAt: startMs,
        })

        return { conversationId, result }
    } catch (err) {
        if (planningRunId) {
            closePlanningRun(
                planningRunId,
                (err as Error).name === 'AbortError' ? 'cancelled' : 'error',
                { error: (err as Error).name === 'AbortError' ? 'Cancelled' : (err as Error).message }
            )
        }
        if ((err as Error).name !== 'AbortError') {
            console.error(`${logPrefix} Error running trigger${agent ? ` for agent ${agent.id}` : ''}:`, (err as Error).message)
            try {
                getEventBus().emit('task:error', { taskId: '', conversationId, error: (err as Error).message })
            } catch { /* ignore */ }
        }
        throw err
    }
}
