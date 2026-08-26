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
import { getAssignedOrDefaultSpaces } from '../memory/memory-space-scope.js'
import { buildPersistedChatConfig } from '../chat/run-config.js'
import { resolveMemorySpaceOverrides } from '../chat/run-config.js'
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
        'INSERT INTO conversations (id, title, agent_id, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(conversationId, title, agent?.id ?? null, origin, Date.now(), Date.now())

    // Notify the caller and persist the trigger input before any fallible
    // context preparation. Failed/cancelled pre-turn work must still leave a
    // coherent conversation that explains what was attempted.
    onConversationCreated?.(conversationId)
    const triggerMsgId = nanoid()
    const triggerCreatedAt = Date.now()
    db.prepare(
        'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(triggerMsgId, conversationId, 'user', userContent, triggerCreatedAt)
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(triggerCreatedAt, conversationId)

    broadcast('chat:new-message', {
        conversationId,
        message: { id: triggerMsgId, conversationId, role: 'user', content: userContent, createdAt: triggerCreatedAt }
    })

    const startMs = Date.now()
    let planningRunId: string | undefined

    try {
        const memorySpaces = agent
            ? getAssignedOrDefaultSpaces(agent.id)
            : (resolveMemorySpaceOverrides(db, executionConfig?.memorySpaceIds) ?? [])
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
                memorySpaceOverrides: memorySpaces,
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
            requestedMemorySpaceIds: memorySpaces.map((space) => space.id),
            systemPrompt: planned.messages.find((message) => message.role === 'system')?.content.toString(),
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
        if (planningRunId) {
            closePlanningRun(planningRunId, 'completed', { summary: result.content.slice(0, 500) })
        }

        // Save assistant message
        const assistantMsgId = nanoid()
        const now = Date.now()
        db.prepare(
            'INSERT INTO messages (id, conversation_id, role, content, provider, model, prompt_tokens, completion_tokens, context_tokens, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(assistantMsgId, conversationId, 'assistant', result.content, planned.providerId || null, planned.responseModel || null, result.usage?.promptTokens ?? null, result.usage?.completionTokens ?? null, result.contextTokens ?? null, now - startMs, now)

        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), conversationId)

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
