import { getGateway } from '../gateway/gateway.js'
import { getAgent, type SubAgentAssignment } from '../agents/agent-store.js'
import { AgentExecutor } from './agent-executor.js'
import { prepareAgentExecution } from './prepare-execution.js'
import { getDb } from '../../db/database.js'
import { nanoid } from 'nanoid'
import type { ToolDefinition, ToolResult } from '../gateway/providers/base.provider.js'

/** Timeout in milliseconds for a single sub-agent tool call. */
const SUB_AGENT_TIMEOUT_MS = 300_000 // 5 minutes 
/** Maximum tool-use rounds for a sub-agent per delegation call. */
const SUB_AGENT_MAX_ROUNDS = 30

type BroadcastFn = (event: string, data: unknown) => void

interface SubAgentToolOptions {
    /** Sub-agent assignments from the orchestrator agent */
    subAgents: SubAgentAssignment[]
    /** Conversation ID for attribution and streaming */
    conversationId: string
    /** WebSocket broadcast function */
    broadcast: BroadcastFn
    /** Abort signal for cancellation */
    signal?: AbortSignal
    /** Session-level model override — when set, overrides the sub-agent's own model */
    modelOverride?: string
    /** Session-level provider override — when set, all sub-agents use this provider */
    providerOverride?: string
    /** Request/global provider fallback for sub-agent tool routing */
    toolRouterProviderId?: string
    /** Request/global model fallback for sub-agent tool routing */
    toolRouterModel?: string
    /** Request/global provider fallback for sub-agent memory routing */
    memoryRouterProviderId?: string
    /** Request/global model fallback for sub-agent memory routing */
    memoryRouterModel?: string
}

/**
 * Build ToolDefinition[] for each configured sub-agent.
 *
 * Each sub-agent becomes a callable tool named `delegate_to_<codename>`.
 * When invoked, the tool spins up an inner AgentExecutor with the
 * sub-agent's own tools, provider, and model.
 */
export function buildSubAgentTools(options: SubAgentToolOptions): ToolDefinition[] {
    const { subAgents, conversationId, broadcast, signal, modelOverride, providerOverride, toolRouterProviderId, toolRouterModel, memoryRouterProviderId, memoryRouterModel } = options
    const tools: ToolDefinition[] = []

    for (const assignment of subAgents) {
        const agentData = getAgent(assignment.agentId)
        if (!agentData) continue

        const toolName = `delegate_to_${assignment.codename}`

        tools.push({
            name: toolName,
            description: `Delegate a task to the "${assignment.codename}" sub-agent. Role: ${assignment.role}. The sub-agent has no memory of prior conversation — provide everything it needs.`,
            parameters: {
                type: 'object',
                properties: {
                    instructions: {
                        type: 'string',
                        description: 'What the sub-agent should do. Be specific about the desired outcome.'
                    },
                    context: {
                        type: 'string',
                        description: 'Relevant background the sub-agent needs to complete the task: conversation history, prior tool outputs, URLs, filenames, data, or any other details it would not otherwise have access to.'
                    }
                },
                required: ['instructions']
            },
            timeout: SUB_AGENT_TIMEOUT_MS,
            execute: async (params: unknown): Promise<ToolResult> => {
                const { instructions, context } = params as { instructions: string; context?: string }

                const userMessage = context
                    ? `## Context\n${context}\n\n## Task\n${instructions}`
                    : instructions

                // Prepare tools, provider/model via the shared builder.
                // includeSubAgents: false prevents infinite delegation recursion.
                const prepared = await prepareAgentExecution({
                    preset: agentData,
                    conversationId,
                    broadcast,
                    providerOverride: providerOverride || undefined,
                    modelOverride: modelOverride || undefined,
                    systemPromptSuffix: '\nYou are a sub-agent. Complete the task described below and report your results clearly.',
                    includeSubAgents: false,
                    toolRouterProviderId,
                    toolRouterModel,
                    memoryRouterProviderId,
                    memoryRouterModel,
                    userQuery: userMessage,
                })

                // Sub-agent executor emits EventBus step events (for timeline cards)
                // and broadcasts WebSocket stream events so the user can see
                // sub-agent thinking/content in real time.
                // This is safe because the outer executor's stream has already
                // ended before tool execution begins (sequential, not concurrent).

                const executor = new AgentExecutor({
                    gateway: getGateway(),
                    tools: prepared.tools,
                    conversationId,
                    broadcast,
                    providerId: prepared.providerId,
                    model: prepared.model,
                    hitl: !agentData.autoApproveTools,
                    maxRounds: SUB_AGENT_MAX_ROUNDS,
                    thinkingEnabled: agentData.thinkingEnabled !== false,
                    signal,
                    streamMode: 'per-round',
                    streamEventPrefix: 'chat:subagent-stream',
                    saveMessages: true,
                    emitEvents: true,
                    eventMeta: { maCodename: assignment.codename, maAgentName: agentData.name },
                    agentId: agentData.id,
                    agentName: agentData.name,
                    agentIconUrl: agentData.iconUrl || null,
                })

                try {
                    const result = await executor.run([
                        ...prepared.systemMessages,
                        { role: 'user', content: userMessage },
                    ])

                    // Save sub-agent's final response as an assistant message
                    // (intermediate rounds are saved by the executor via saveMessages: true)
                    if (result.content) {
                        const db = getDb()
                        db.prepare(
                            'INSERT INTO messages (id, conversation_id, role, content, thinking, agent_id, provider, model, prompt_tokens, completion_tokens, context_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                        ).run(
                            nanoid(), conversationId, 'assistant', result.content, result.thinking || null, agentData.id,
                            result.provider || prepared.providerId || null,
                            result.model || prepared.model || null,
                            result.usage?.promptTokens ?? null,
                            result.usage?.completionTokens ?? null,
                            result.contextTokens ?? null,
                            Date.now()
                        )
                    }

                    // Separate file-path URLs (for UI display) from base64 data-URLs
                    // (for LLM vision context in the parent) so the parent executor
                    // can inject them into the conversation correctly.
                    const fileImages: string[] = []
                    const dataImages: string[] = []
                    for (const img of result.images) {
                        if (img.startsWith('data:')) {
                            dataImages.push(img)
                        } else {
                            fileImages.push(img)
                        }
                    }

                    return {
                        success: true,
                        output: result.content || '(no output)',
                        images: fileImages.length ? fileImages : undefined,
                        imageDataUrls: dataImages.length ? dataImages : undefined,
                    }
                } catch (err) {
                    return {
                        success: false,
                        output: '',
                        error: `Sub-agent "${assignment.codename}" failed: ${(err as Error).message}`,
                    }
                }
            }
        })
    }

    return tools
}

/**
 * Build a system prompt section that describes available sub-agents.
 */
export function buildSubAgentPrompt(subAgents: SubAgentAssignment[]): string {
    const lines = [
        '\n## Sub-Agents',
        'You have sub-agents you can delegate tasks to. Invoke them by calling their `delegate_to_<codename>_agent` tool.',
        'Each sub-agent is specialized — delegate tasks that match their role rather than trying to do everything yourself.',
        'Sub-agents have no memory of your conversation. Use the `context` parameter to pass any relevant background they need, and `instructions` for the specific task.\n',
    ]

    for (const sa of subAgents) {
        const agentData = getAgent(sa.agentId)
        if (!agentData) continue
        lines.push(`- **delegate_to_${sa.codename}** (${agentData.name}): ${sa.role}`)
    }

    return lines.join('\n')
}
