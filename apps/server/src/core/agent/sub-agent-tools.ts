import { getGateway } from '../gateway/gateway.js'
import { getAgent, type SubAgentAssignment } from '../agents/agent-store.js'
import { AgentExecutor } from './agent-executor.js'
import { prepareAgentExecution } from './prepare-execution.js'
import { getDb } from '../../db/database.js'
import { getAssignedOrDefaultSpaces } from '../memory/memory-space-scope.js'
import { extractFilePathFromFileUrl } from '../artifacts/image-artifacts.js'
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
}

/**
 * Build the sub-agent spawning tool.
 *
 * The orchestrator gets one callable tool named `spawn_subagent`.
 * When invoked with a configured codename, the tool spins up an inner AgentExecutor with the
 * sub-agent's own tools, provider, and model.
 */
export function buildSubAgentTools(options: SubAgentToolOptions): ToolDefinition[] {
    const { subAgents, conversationId, broadcast, signal } = options
    const availableSubAgents = subAgents
        .map((assignment) => {
            const agentData = getAgent(assignment.agentId)
            return agentData ? { agentData } : null
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)

    if (!availableSubAgents.length) return []

    const nameList = availableSubAgents.map(({ agentData }) => agentData.internalName).join(', ')

    return [{
        name: 'spawn_subagent',
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
        execute: async (params: unknown): Promise<ToolResult> => {
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
            const eventMeta = {
                maCodename: agentData.internalName,
                maAgentName: agentData.name,
                maInvocationId: invocationId,
            }

            const userMessage = context
                ? `## Context\n${context}\n\n## Task\n${instructions}`
                : instructions

            // Prepare tools, provider/model via the shared builder.
            // includeSubAgents: false prevents infinite delegation recursion.
            const prepared = await prepareAgentExecution({
                preset: agentData,
                conversationId,
                broadcast,
                systemPromptSuffix: '\nYou are a sub-agent. Complete the task described below and report your results clearly.',
                includeSubAgents: false,
                userQuery: userMessage,
                autoMemory: agentData.autoMemory === true,
                memorySpaceOverrides: getAssignedOrDefaultSpaces(agentData.id),
                eventMeta,
            })
            const gateway = getGateway()
            const responseProvider = prepared.providerId || gateway.getLastUsedProvider().config.id
            const responseSupportsToolCalls = await gateway.modelSupportsToolCalls(prepared.model, responseProvider)
            const responseTools = responseSupportsToolCalls ? prepared.tools : []

            // Sub-agent executor emits EventBus step events (for timeline cards)
            // and broadcasts WebSocket stream events so the user can see
            // sub-agent thinking/content in real time.
            // This is safe because the outer executor's stream has already
            // ended before tool execution begins (sequential, not concurrent).

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
                signal,
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
                const result = await executor.run([
                    ...prepared.systemMessages,
                    { role: 'user', content: userMessage },
                ])

                // Save sub-agent's final response as an assistant message
                // (intermediate rounds are saved by the executor via saveMessages: true)
                if (result.content || result.images.length) {
                    const db = getDb()
                    db.prepare(
                        `INSERT INTO messages (
                            id, conversation_id, role, content, thinking, image_urls_json, agent_id,
                            ma_codename, ma_agent_name, ma_invocation_id,
                            provider, model, prompt_tokens, completion_tokens, context_tokens, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                    ).run(
                        nanoid(), conversationId, 'assistant', result.content, result.thinking || null,
                        result.images.length ? JSON.stringify(result.images) : null,
                        agentData.id,
                        eventMeta.maCodename,
                        eventMeta.maAgentName,
                        eventMeta.maInvocationId,
                        result.provider || prepared.providerId || null,
                        result.model || prepared.model || null,
                        result.usage?.promptTokens ?? null,
                        result.usage?.completionTokens ?? null,
                        result.contextTokens ?? null,
                        Date.now()
                    )
                }

                const imageLines = result.images.map((url, index) => {
                    const path = extractFilePathFromFileUrl(url)
                    return `image ${index + 1}: ${path ? `path=${path}; ` : ''}url=${url}`
                })
                const output = [
                    result.content?.trim(),
                    imageLines.length
                        ? `Sub-agent produced ${imageLines.length} image artifact${imageLines.length === 1 ? '' : 's'}:\n${imageLines.join('\n')}`
                        : '',
                ].filter(Boolean).join('\n\n') || '(no output)'

                return {
                    success: true,
                    output,
                    images: result.images.length ? result.images : undefined,
                }
            } catch (err) {
                return {
                    success: false,
                    output: '',
                    error: `Sub-agent "${agentData.internalName}" failed: ${(err as Error).message}`,
                }
            }
        }
    }]
}

/**
 * Build a system prompt section that describes available sub-agents.
 */
export function buildSubAgentPrompt(subAgents: SubAgentAssignment[]): string {
    const lines = [
        '\n## Sub-Agents',
        'You have sub-agents you can delegate tasks to. Invoke them by calling the `spawn_subagent` tool with the sub-agent `internalName`, `instructions`, and any needed `context`.',
        'Each sub-agent is specialized — delegate tasks that match their description rather than trying to do everything yourself.',
        'Sub-agents have no memory of your conversation. Use the `context` parameter to pass any relevant background they need, and `instructions` for the specific task.\n',
    ]

    for (const sa of subAgents) {
        const agentData = getAgent(sa.agentId)
        if (!agentData) continue
        lines.push(`- **${agentData.internalName}** (${agentData.name}): ${agentData.description}`)
    }

    return lines.join('\n')
}
