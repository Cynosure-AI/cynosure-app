import { getGateway } from '../gateway/gateway.js'
import { getAgent, type SubAgentAssignment } from '../agents/agent-store.js'
import { AgentExecutor } from './agent-executor.js'
import { prepareAgentExecution } from './prepare-execution.js'
import { getDb } from '../../db/database.js'
import { getAssignedOrDefaultSpaces } from '../memory/memory-space-scope.js'
import { extractFilePathFromFileUrl } from '../artifacts/image-artifacts.js'
import { nanoid } from 'nanoid'
import type { ChatMessage, ToolDefinition, ToolResult } from '../gateway/providers/base.provider.js'

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
    /** Root execution metadata propagated through delegated work. */
    eventMeta?: Record<string, unknown>
}

interface SubAgentSessionRow {
    invocation_id: string
    agent_id: string
    history_json: string
}

function parseSessionHistory(json: string): ChatMessage[] | null {
    try {
        const history = JSON.parse(json) as unknown
        if (!Array.isArray(history)) return null
        if (!history.every((message) => message && typeof message === 'object'
            && ((message as ChatMessage).role === 'user' || (message as ChatMessage).role === 'assistant')
            && typeof (message as ChatMessage).content === 'string')) return null
        return history as ChatMessage[]
    } catch {
        return null
    }
}

/**
 * Build the sub-agent spawning tool.
 *
 * The orchestrator gets tools to spawn and continue durable sub-agent sessions.
 * When invoked with a configured codename, the tool spins up an inner AgentExecutor with the
 * sub-agent's own tools, provider, and model.
 */
export function buildSubAgentTools(options: SubAgentToolOptions): ToolDefinition[] {
    const { subAgents, conversationId, broadcast, signal, eventMeta: rootEventMeta } = options
    const availableSubAgents = subAgents
        .map((assignment) => {
            const agentData = getAgent(assignment.agentId)
            return agentData ? { agentData } : null
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)

    if (!availableSubAgents.length) return []

    const nameList = availableSubAgents.map(({ agentData }) => agentData.internalName).join(', ')

    const runSubAgent = async (input: {
        agentData: NonNullable<ReturnType<typeof getAgent>>
        invocationId: string
        history: ChatMessage[]
        activeSignal?: AbortSignal
    }): Promise<ToolResult> => {
        const { agentData, invocationId, history, activeSignal } = input
        const latestUserMessage = history.at(-1)?.content
        const eventMeta = {
            ...rootEventMeta,
            maCodename: agentData.internalName,
            maAgentName: agentData.name,
            maInvocationId: invocationId,
        }

        const prepared = await prepareAgentExecution({
            preset: agentData,
            conversationId,
            broadcast,
            systemPromptSuffix: '\nYou are a sub-agent continuing a private delegated session. Complete the latest task and report your results clearly.',
            includeSubAgents: false,
            userQuery: typeof latestUserMessage === 'string' ? latestUserMessage : '',
            autoMemory: agentData.autoMemory === true,
            memorySpaceOverrides: getAssignedOrDefaultSpaces(agentData.id),
            eventMeta,
            signal: activeSignal,
        })
        activeSignal?.throwIfAborted()
        const gateway = getGateway()
        const responseProvider = prepared.providerId || gateway.getLastUsedProvider().config.id
        const responseSupportsToolCalls = await gateway.modelSupportsToolCalls(prepared.model, responseProvider)
        activeSignal?.throwIfAborted()
        const responseTools = responseSupportsToolCalls ? prepared.tools : []
        const executor = new AgentExecutor({
            gateway,
            tools: responseTools,
            conversationId,
            broadcast,
            providerId: prepared.providerId,
            model: prepared.model,
            hitl: !agentData.autoApproveTools,
            maxRounds: SUB_AGENT_MAX_ROUNDS,
            thinkingEnabled: agentData.thinkingEnabled !== false,
            reasoningEffort: agentData.reasoningEffort,
            signal: activeSignal,
            streamMode: 'per-round',
            streamEventPrefix: 'chat:subagent-stream',
            saveMessages: true,
            emitEvents: true,
            eventMeta,
            agentId: agentData.id,
            agentName: agentData.name,
            agentIconUrl: agentData.iconUrl || null,
        })

        try {
            const result = await executor.run([...prepared.systemMessages, ...history])
            activeSignal?.throwIfAborted()

            if (result.content || result.images.length) {
                activeSignal?.throwIfAborted()
                const db = getDb()
                const messageId = nanoid()
                const createdAt = Date.now()
                db.prepare(
                    `INSERT INTO messages (
                        id, conversation_id, role, content, thinking, image_urls_json, generated_media, agent_id,
                        ma_codename, ma_agent_name, ma_invocation_id,
                        provider, model, prompt_tokens, completion_tokens, context_tokens, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                ).run(
                    messageId, conversationId, 'assistant', result.content, result.thinking || null,
                    result.images.length ? JSON.stringify(result.images) : null,
                    result.images.length ? 1 : 0,
                    agentData.id, eventMeta.maCodename, eventMeta.maAgentName, invocationId,
                    result.provider || prepared.providerId || null,
                    result.model || prepared.model || null,
                    result.usage?.promptTokens ?? null, result.usage?.completionTokens ?? null,
                    result.contextTokens ?? null, createdAt
                )
                broadcast('chat:new-message', {
                    conversationId, streamId: executor.lastStreamId,
                    message: { id: messageId, conversationId, role: 'assistant', content: result.content, createdAt, agentId: agentData.id },
                })
            }

            const nextHistory = [...history, { role: 'assistant' as const, content: result.content || '(no output)' }]
            getDb().prepare('UPDATE subagent_sessions SET history_json = ?, updated_at = ? WHERE invocation_id = ? AND conversation_id = ?')
                .run(JSON.stringify(nextHistory), Date.now(), invocationId, conversationId)

            const imageLines = result.images.map((url, index) => {
                const path = extractFilePathFromFileUrl(url)
                return `image ${index + 1}: ${path ? `path=${path}; ` : ''}url=${url}`
            })
            const response = [
                result.content?.trim(),
                imageLines.length
                    ? `Sub-agent produced ${imageLines.length} image artifact${imageLines.length === 1 ? '' : 's'}:\n${imageLines.join('\n')}`
                    : '',
            ].filter(Boolean).join('\n\n') || '(no output)'
            return {
                success: true,
                output: `Sub-agent invocation ID: ${invocationId}\n\n${response}`,
                structuredContent: { invocationId, response },
                images: result.images.length ? result.images : undefined,
            }
        } catch (err) {
            return { success: false, output: '', error: `Sub-agent "${agentData.internalName}" failed: ${(err as Error).message}` }
        }
    }

    const spawnTool: ToolDefinition = {
        name: 'spawn_subagent',
        execution: { readOnly: false },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description: `Spawn one of the configured sub-agents by internal name. Available agents: ${nameList}. The sub-agent has no memory of prior conversation — provide everything it needs.`,
        parameters: {
            type: 'object',
            properties: {
                internalName: {
                    type: 'string',
                    description: 'The internal name of the sub-agent to spawn.',
                    enum: availableSubAgents.map(({ agentData }) => agentData.internalName),
                },
                instructions: {
                    type: 'string',
                    description: 'What the sub-agent should do. Be specific about the desired outcome.'
                },
                context: {
                    type: 'string',
                    description: 'Relevant background the sub-agent needs to complete the task: conversation history, prior tool outputs, URLs, filenames, data, or any other details it would not otherwise have access to.'
                }
            },
            required: ['internalName', 'instructions']
        },
        timeout: SUB_AGENT_TIMEOUT_MS,
        execute: async (params: unknown, executionSignal?: AbortSignal): Promise<ToolResult> => {
            const activeSignal = executionSignal ?? signal
            activeSignal?.throwIfAborted()
            const { internalName, instructions, context } = params as { internalName: string; instructions: string; context?: string }
            const selected = availableSubAgents.find(({ agentData }) => agentData.internalName === internalName)

            if (!selected) {
                return {
                    success: false,
                    output: '',
                    error: `Unknown sub-agent internal name "${internalName}". Available agents: ${nameList}`,
                }
            }

            const { agentData } = selected
            const invocationId = nanoid()
            const userMessage = context
                ? `## Context\n${context}\n\n## Task\n${instructions}`
                : instructions
            const history: ChatMessage[] = [{ role: 'user', content: userMessage }]
            const now = Date.now()
            getDb().prepare('INSERT INTO subagent_sessions (invocation_id, conversation_id, agent_id, history_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
                .run(invocationId, conversationId, agentData.id, JSON.stringify(history), now, now)
            return runSubAgent({ agentData, invocationId, history, activeSignal })
        }
    }

    const continueTool: ToolDefinition = {
        name: 'continue_subagent',
        execution: { readOnly: false },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description: 'Continue a previously spawned sub-agent session using its invocation ID. The sub-agent receives its private prior session transcript plus this follow-up, not the parent conversation.',
        parameters: {
            type: 'object',
            properties: {
                invocationId: { type: 'string', description: 'Invocation ID returned by spawn_subagent.' },
                instructions: { type: 'string', description: 'The follow-up task or question for the sub-agent.' },
                context: { type: 'string', description: 'Optional new parent context to explicitly share with the sub-agent.' },
            },
            required: ['invocationId', 'instructions'],
        },
        timeout: SUB_AGENT_TIMEOUT_MS,
        execute: async (params: unknown, executionSignal?: AbortSignal): Promise<ToolResult> => {
            const activeSignal = executionSignal ?? signal
            activeSignal?.throwIfAborted()
            const { invocationId, instructions, context } = params as { invocationId: string; instructions: string; context?: string }
            const session = getDb().prepare(
                'SELECT invocation_id, agent_id, history_json FROM subagent_sessions WHERE invocation_id = ? AND conversation_id = ?'
            ).get(invocationId, conversationId) as SubAgentSessionRow | undefined
            if (!session) return { success: false, output: '', error: `No sub-agent session "${invocationId}" exists in this conversation.` }
            const selected = availableSubAgents.find(({ agentData }) => agentData.id === session.agent_id)
            if (!selected) return { success: false, output: '', error: `The sub-agent for session "${invocationId}" is no longer assigned or available.` }
            const history = parseSessionHistory(session.history_json)
            if (!history) return { success: false, output: '', error: `Sub-agent session "${invocationId}" has invalid history.` }
            const followUp = context ? `## New Context\n${context}\n\n## Follow-up Task\n${instructions}` : instructions
            return runSubAgent({ agentData: selected.agentData, invocationId, history: [...history, { role: 'user', content: followUp }], activeSignal })
        },
    }

    return [spawnTool, continueTool]
}

/**
 * Build a system prompt section that describes available sub-agents.
 */
export function buildSubAgentPrompt(subAgents: SubAgentAssignment[]): string {
    const lines = [
        '\n## Sub-Agents',
        'You have sub-agents you can delegate tasks to. Start a session with `spawn_subagent`, then use the returned `invocationId` with `continue_subagent` for follow-up work in the same private session.',
        'Each sub-agent is specialized — delegate tasks that match their description rather than trying to do everything yourself.',
        'Sub-agents do not automatically see the parent conversation. Pass relevant background through `context`; continued sessions remember their own prior exchanges.\n',
    ]

    for (const sa of subAgents) {
        const agentData = getAgent(sa.agentId)
        if (!agentData) continue
        lines.push(`- **${agentData.internalName}** (${agentData.name}): ${agentData.description}`)
    }

    return lines.join('\n')
}
