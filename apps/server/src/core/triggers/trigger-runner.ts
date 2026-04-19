import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { getGateway } from '../gateway/gateway.js'
import { getEventBus } from '../telemetry/event-bus.js'
import { AgentExecutor, type AgentExecutorResult } from '../agent/agent-executor.js'
import { prepareAgentExecution } from '../agent/prepare-execution.js'
import type { AgentData } from '../agents/agent-files.js'
import type { ChatMessage } from '../gateway/providers/base.provider.js'

type BroadcastFn = (event: string, data: unknown) => void

export interface TriggerRunConfig {
    /** Agent definition (from getAgent) */
    agent: AgentData
    /** User message content for this trigger execution */
    userContent: string
    /** Conversation origin label (e.g. 'cron', 'file-watcher') */
    origin: string
    /** Conversation title */
    title: string
    /** Suffix appended to the agent's system prompt */
    systemPromptSuffix: string
    /** Provider override (optional) */
    providerOverride?: string
    /** Model override (optional) */
    modelOverride?: string
    /** WebSocket broadcast function */
    broadcast: BroadcastFn
    /** Abort signal for cancellation */
    signal: AbortSignal
    /** Log prefix for console messages (e.g. '[cron]', '[file-watcher]') */
    logPrefix: string
    /** Called as soon as the conversation is created, before execution starts */
    onConversationCreated?: (conversationId: string) => void
}

export interface TriggerRunResult {
    conversationId: string
    result: AgentExecutorResult
}

/**
 * Shared orchestration for trigger-based agent executions (cron, file-watcher).
 *
 * Creates a conversation, prepares the execution context, runs the agent
 * executor, saves messages, and returns the result. The caller is responsible
 * for managing abort controllers and active-run tracking.
 */
export async function runTriggerExecution(config: TriggerRunConfig): Promise<TriggerRunResult> {
    const { agent, userContent, origin, title, systemPromptSuffix, providerOverride, modelOverride, broadcast, signal, logPrefix, onConversationCreated } = config
    const gateway = getGateway()
    const db = getDb()

    // Create conversation
    const conversationId = nanoid()
    db.prepare(
        'INSERT INTO conversations (id, title, agent_id, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(conversationId, title, agent.id, origin, Date.now(), Date.now())

    // Notify caller of the conversationId before execution starts
    onConversationCreated?.(conversationId)

    // Prepare execution: tools, memory, system prompt, provider/model
    const prepared = await prepareAgentExecution({
        agent,
        conversationId,
        broadcast,
        providerOverride,
        modelOverride,
        systemPromptSuffix,
        userQuery: userContent,
        isFirstMessage: true,
    })

    // Persist session config so the chat view can restore the correct model/provider
    const chatConfig = JSON.stringify({
        model: prepared.model,
        providerId: prepared.providerId,
        thinkingEnabled: agent.thinkingEnabled !== false,
    })
    db.prepare('UPDATE conversations SET config_json = ? WHERE id = ?').run(chatConfig, conversationId)

    const messages: ChatMessage[] = [
        ...prepared.systemMessages,
        { role: 'user', content: userContent }
    ]

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
        tools: prepared.tools,
        conversationId,
        broadcast,
        providerId: prepared.providerId,
        model: prepared.model,
        maxRounds: 10,
        thinkingEnabled: agent.thinkingEnabled !== false,
        streamMode: 'per-round',
        hitl: !agent.autoApproveTools,
        agentId: agent.id,
        agentName: agent.name,
        agentIconUrl: agent.iconUrl || null,
        signal,
    })

    const startMs = Date.now()

    try {
        const result = await executor.run(messages)

        // Save assistant message
        const assistantMsgId = nanoid()
        const now = Date.now()
        db.prepare(
            'INSERT INTO messages (id, conversation_id, role, content, provider, model, prompt_tokens, completion_tokens, context_tokens, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(assistantMsgId, conversationId, 'assistant', result.content, prepared.providerId || null, prepared.model || null, result.usage?.promptTokens ?? null, result.usage?.completionTokens ?? null, result.contextTokens ?? null, now - startMs, now)

        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), conversationId)

        return { conversationId, result }
    } catch (err) {
        if ((err as Error).name !== 'AbortError') {
            console.error(`${logPrefix} Error running trigger for agent ${agent.id}:`, (err as Error).message)
            try {
                getEventBus().emit('task:error', { taskId: '', conversationId, error: (err as Error).message })
            } catch { /* ignore */ }
        }
        throw err
    }
}
