import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { getGateway } from '../gateway/gateway.js'
import { getEventBus } from '../telemetry/event-bus.js'
import { AgentExecutor, type AgentExecutorResult } from '../agent/agent-executor.js'
import { planExecution } from '../agent/pre-execution/execution-planner.js'
import { closeOrchestrationRun } from '../agent/orchestration-state.js'
import { getToolRegistry } from '../tools/tool-registry.js'
import type { AgentData } from '../agents/agent-store.js'
import type { ChatMessage } from '../gateway/providers/base.provider.js'
import { getAssignedOrDefaultSpaces } from '../memory/memory-space-scope.js'
import { buildPersistedChatConfig } from '../chat/run-config.js'

type BroadcastFn = (event: string, data: unknown) => void

export interface TriggerRunConfig {
    /** Agent definition (from getAgent) */
    agent: AgentData
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
    const { agent, userContent, origin, title, systemPromptSuffix, broadcast, signal, logPrefix, onConversationCreated } = config
    const gateway = getGateway()
    const db = getDb()

    // Create conversation
    const conversationId = nanoid()
    db.prepare(
        'INSERT INTO conversations (id, title, agent_id, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(conversationId, title, agent.id, origin, Date.now(), Date.now())

    // Notify caller of the conversationId before execution starts
    onConversationCreated?.(conversationId)
    const memorySpaces = getAssignedOrDefaultSpaces(agent.id).map((space) => ({ id: space.id, name: space.name }))

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
            memorySpaceOverrides: memorySpaces,
            autoMemory: agent.autoMemory === true,
            thinkingEnabled: agent.thinkingEnabled !== false,
        },
    })

    // Persist session config so the chat view can restore the correct model/provider
    const executionConfig = buildPersistedChatConfig({
        selectedToolKeys: agent.tools,
        requestedSubAgents: agent.subAgents,
        requestedMemorySpaceIds: memorySpaces.map((space) => space.id),
        systemPrompt: planned.messages.find((message) => message.role === 'system')?.content.toString(),
        responseModel: planned.responseModel,
        responseProvider: planned.responseProvider,
        thinkingEnabled: agent.thinkingEnabled !== false,
        autoToolRouting: agent.autoToolRouting === true,
        autoMemory: agent.autoMemory === true,
        selectedSkillIds: agent.skills,
        autoSkillRouting: agent.autoSkillRouting !== false,
    })
    db.prepare('UPDATE conversations SET execution_config_json = ? WHERE id = ?').run(JSON.stringify(executionConfig), conversationId)

    const messages: ChatMessage[] = planned.messages

    // Save trigger message
    const triggerMsgId = nanoid()
    db.prepare(
        'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(triggerMsgId, conversationId, 'user', userContent, Date.now())

    broadcast('chat:new-message', {
        conversationId,
        message: { id: triggerMsgId, conversationId, role: 'user', content: userContent, createdAt: Date.now() }
    })

    // Run executor
    const executor = new AgentExecutor({
        gateway,
        tools: planned.tools,
        conversationId,
        broadcast,
        providerId: planned.providerId,
        model: planned.responseModel,
        maxRounds: 10,
        thinkingEnabled: agent.thinkingEnabled !== false,
        streamMode: 'per-round',
        hitl: !agent.autoApproveTools,
        agentId: agent.id,
        agentName: agent.name,
        agentIconUrl: agent.iconUrl || null,
        signal,
        orchestrationRunId: planned.orchestrationRunId,
    })

    const startMs = Date.now()

    try {
        const result = await executor.run(messages)
        if (planned.orchestrationRunId) {
            closeOrchestrationRun(planned.orchestrationRunId, 'completed', { summary: result.content.slice(0, 500) })
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
        if (planned.orchestrationRunId) {
            closeOrchestrationRun(
                planned.orchestrationRunId,
                (err as Error).name === 'AbortError' ? 'cancelled' : 'error',
                { error: (err as Error).name === 'AbortError' ? 'Cancelled' : (err as Error).message }
            )
        }
        if ((err as Error).name !== 'AbortError') {
            console.error(`${logPrefix} Error running trigger for agent ${agent.id}:`, (err as Error).message)
            try {
                getEventBus().emit('task:error', { taskId: '', conversationId, error: (err as Error).message })
            } catch { /* ignore */ }
        }
        throw err
    }
}
