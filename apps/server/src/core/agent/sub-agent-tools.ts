import { customAlphabet, nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { getAgent, type SubAgentAssignment } from '../agents/agent-store.js'
import { readFileAttachmentText } from '../artifacts/file-artifacts.js'
import { artifactFileUrlToDataUrl, extractFilePathFromFileUrl } from '../artifacts/image-artifacts.js'
import { messageContentJson, messageToTranscriptItem, publishChatEvent } from '../chat/transcript.js'
import { assembleExecutionMessages } from '../chat/message-history.js'
import { getGateway } from '../gateway/gateway.js'
import type { ChatMessage, ContentPart, ToolDefinition, ToolResult } from '../gateway/providers/base.provider.js'
import { getAssignedMemoryFolders } from '../memory/memory-folder-scope.js'
import { AgentExecutor } from './agent-executor.js'
import { prepareAgentExecution } from './prepare-execution.js'
import { listRoutableToolKeys, resolveExecutionToolPolicy, stripAutomaticallyManagedMemoryToolKeys } from './pre-execution/execution-planner.js'
import { getToolRegistry } from '../tools/tool-registry.js'

/** Maximum execution time for delegated work before the sub-agent is aborted. */
const SUB_AGENT_EXECUTION_TIMEOUT_MS = 300_000 // 5 minutes
/**
 * The outer tool timeout is only a final safety net. Keeping it slightly above
 * the execution timeout lets the inner executor observe cancellation and shut
 * down before the orchestrator receives a result.
 */
const SUB_AGENT_TOOL_TIMEOUT_MS = SUB_AGENT_EXECUTION_TIMEOUT_MS + 10_000
/** Maximum tool-use rounds for a sub-agent per delegation call. */
const SUB_AGENT_MAX_ROUNDS = 30
/** Short, readable suffix without visually ambiguous characters (0/O, 1/I/l). */
const createInvocationSuffix = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 8)

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

interface ConversationMessageAttachmentRow {
    id: string
    content_blocks_json: string | null
    created_at: number
}

interface ConversationFileAttachmentRow {
    id: string
    message_id: string
    name: string
    original_path: string | null
    text_path: string | null
    created_at: number
}

function isContentPart(value: unknown): value is ContentPart {
    if (!value || typeof value !== 'object') return false
    const part = value as Partial<ContentPart>
    if (part.type === 'text') return typeof part.text === 'string'
    if (part.type === 'image_url') return typeof part.image_url?.url === 'string'
    if (part.type === 'audio_url') return typeof part.audio_url?.url === 'string'
    return false
}

function isMessageContent(value: unknown): value is ChatMessage['content'] {
    return typeof value === 'string' || (Array.isArray(value) && value.every(isContentPart))
}

function parseSessionHistory(json: string): ChatMessage[] | null {
    try {
        const history = JSON.parse(json) as unknown
        if (!Array.isArray(history)) return null
        if (!history.every((message) => message && typeof message === 'object'
            && ((message as ChatMessage).role === 'user' || (message as ChatMessage).role === 'assistant')
            && isMessageContent((message as ChatMessage).content))) return null
        return history as ChatMessage[]
    } catch {
        return null
    }
}

function parseMediaBlocks(json: string | null): Array<{ type: 'image' | 'audio'; url: string }> {
    if (!json) return []
    try {
        const value = JSON.parse(json) as unknown
        if (!Array.isArray(value)) return []
        return value.filter((block): block is { type: 'image' | 'audio'; url: string } =>
            block !== null && typeof block === 'object'
            && (block.type === 'image' || block.type === 'audio')
            && typeof block.url === 'string')
    } catch {
        return []
    }
}

/** List lazy loaders for every attachment in this conversation, newest message first. */
function listConversationAttachments(conversationId: string): Array<() => ContentPart[]> {
    const db = getDb()
    const messages = db.prepare(`
        SELECT id, content_blocks_json, created_at
        FROM messages
        WHERE conversation_id = ? AND role = 'user'
        ORDER BY created_at DESC, id DESC
    `).all(conversationId) as ConversationMessageAttachmentRow[]
    const files = db.prepare(`
        SELECT id, message_id, name, original_path, text_path, created_at
        FROM message_attachments
        WHERE conversation_id = ? AND kind = 'file'
        ORDER BY created_at DESC, id DESC
    `).all(conversationId) as ConversationFileAttachmentRow[]
    const filesByMessage = new Map<string, ConversationFileAttachmentRow[]>()
    for (const file of files) {
        const current = filesByMessage.get(file.message_id) || []
        current.push(file)
        filesByMessage.set(file.message_id, current)
    }

    const attachments: Array<() => ContentPart[]> = []
    for (const message of messages) {
        for (const block of parseMediaBlocks(message.content_blocks_json)) {
            attachments.push(() => {
                const url = artifactFileUrlToDataUrl(block.url) || block.url
                return block.type === 'image'
                    ? [{ type: 'image_url', image_url: { url } }]
                    : [{ type: 'audio_url', audio_url: { url } }]
            })
        }
        for (const file of filesByMessage.get(message.id) || []) {
            attachments.push(() => {
                const text = readFileAttachmentText({ textPath: file.text_path || undefined })
                const details = [
                    `[Attached file: ${file.name}; attachmentId: ${file.id}]`,
                    file.original_path ? `Path: ${file.original_path}` : '',
                    text || '',
                ].filter(Boolean).join('\n')
                return [{ type: 'text', text: details }]
            })
        }
    }
    return attachments
}

function messageText(content: ChatMessage['content']): string {
    if (typeof content === 'string') return content
    return content.filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text).join('\n')
}

function createInvocationId(internalName: string): string {
    const readableName = internalName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32) || 'subagent'
    return `${readableName}-${createInvocationSuffix()}`
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
        const executionTimeoutSignal = AbortSignal.timeout(SUB_AGENT_EXECUTION_TIMEOUT_MS)
        const subAgentSignal = activeSignal
            ? AbortSignal.any([activeSignal, executionTimeoutSignal])
            : executionTimeoutSignal
        const latestUserMessage = history.at(-1)?.content
        const eventMeta = {
            ...rootEventMeta,
            maCodename: agentData.internalName,
            maAgentName: agentData.name,
            maInvocationId: invocationId,
        }

        const toolPolicy = resolveExecutionToolPolicy({
            selectedToolKeys: [],
            hasRequestToolSelection: false,
            agentToolKeys: stripAutomaticallyManagedMemoryToolKeys(agentData.tools),
            allRegisteredToolKeys: listRoutableToolKeys(getToolRegistry()),
            hasExplicitToolAllowlist: false,
            autoToolRouting: agentData.autoToolRouting === true,
            hasResolvedAgent: true,
        })

        const prepared = await prepareAgentExecution({
            preset: { ...agentData, tools: toolPolicy.configuredTools },
            conversationId,
            broadcast,
            systemPromptSuffix: '\nYou are a sub-agent continuing a private delegated session. Complete the latest task and report your results clearly.',
            includeSubAgents: false,
            autoToolRouting: toolPolicy.autoToolRouting,
            preferredToolKeys: toolPolicy.fixedToolKeys,
            routingToolKeys: toolPolicy.routingToolKeys,
            userQuery: latestUserMessage ? messageText(latestUserMessage) : '',
            // Follow-ups such as "now do the same for Y" need the private session transcript to route.
            recentMessages: history.slice(0, -1),
            autoMemory: agentData.autoMemory === true,
            memoryFolderOverrides: getAssignedMemoryFolders(agentData.id),
            eventMeta,
            signal: subAgentSignal,
        })
        subAgentSignal.throwIfAborted()
        const gateway = getGateway()
        const responseProvider = prepared.providerId || gateway.getLastUsedProvider().config.id
        const responseSupportsToolCalls = await gateway.modelSupportsToolCalls(prepared.model, responseProvider)
        subAgentSignal.throwIfAborted()
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
            signal: subAgentSignal,
            streamMode: 'per-round',
            streamScope: 'subagent',
            saveMessages: true,
            emitEvents: true,
            eventMeta,
            agentId: agentData.id,
            agentName: agentData.name,
            agentIconUrl: agentData.iconUrl || null,
        })

        try {
            const result = await executor.run(assembleExecutionMessages(prepared.contextBundle.messages, history))
            subAgentSignal.throwIfAborted()

            if (result.content || result.images.length) {
                subAgentSignal.throwIfAborted()
                const db = getDb()
                const messageId = nanoid()
                const createdAt = Date.now()
                db.prepare(
                    `INSERT INTO messages (
                        id, conversation_id, role, content, content_blocks_json, generated_media, agent_id,
                        ma_codename, ma_agent_name, ma_invocation_id,
                        provider, model, prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens,
                        context_tokens, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                ).run(
                    messageId, conversationId, 'assistant', result.content,
                    messageContentJson({ id: messageId, content: result.content, thinking: result.thinking, imageDataUrls: result.images }),
                    result.images.length ? 1 : 0,
                    agentData.id, eventMeta.maCodename, eventMeta.maAgentName, invocationId,
                    result.provider || prepared.providerId || null,
                    result.model || prepared.model || null,
                    result.usage?.promptTokens ?? null, result.usage?.completionTokens ?? null,
                    result.usage?.cacheReadTokens ?? null, result.usage?.cacheWriteTokens ?? null,
                    result.contextTokens ?? null, createdAt
                )
                publishChatEvent(broadcast, {
                    conversationId, executionId: executor.lastStreamId, payload: {
                        type: 'transcript-item', item: messageToTranscriptItem({
                            id: messageId, role: 'assistant', content: result.content,
                            thinking: result.thinking, imageDataUrls: result.images, createdAt,
                            agentId: agentData.id, agentName: agentData.name, agentIconUrl: agentData.iconUrl || null,
                            maCodename: eventMeta.maCodename, maAgentName: eventMeta.maAgentName,
                            maInvocationId: invocationId,
                        }, executor.lastStreamId),
                    }
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
                },
                attachmentIndex: {
                    type: 'integer',
                    minimum: 1,
                    description: 'Only set this when the user shared an image, audio, or file attachment the sub-agent must see; omit it otherwise. One-based reference to an attachment in the parent conversation, ordered newest message first; within a message: images, audio, then files. 1 is the most recent attachment.'
                },
            },
            required: ['internalName', 'instructions']
        },
        timeout: SUB_AGENT_TOOL_TIMEOUT_MS,
        execute: async (params: unknown, executionSignal?: AbortSignal): Promise<ToolResult> => {
            const activeSignal = executionSignal ?? signal
            activeSignal?.throwIfAborted()
            const { internalName, instructions, context, attachmentIndex } = params as { internalName: string; instructions: string; context?: string; attachmentIndex?: number | null }
            const selected = availableSubAgents.find(({ agentData }) => agentData.internalName === internalName)

            if (!selected) {
                return {
                    success: false,
                    output: '',
                    error: `Unknown sub-agent internal name "${internalName}". Available agents: ${nameList}`,
                }
            }

            const { agentData } = selected
            const invocationId = createInvocationId(agentData.internalName)
            const userMessage = context
                ? `## Context\n${context}\n\n## Task\n${instructions}`
                : instructions
            // Models sometimes fill the optional index even when nothing is attached;
            // ignore it in that case instead of failing the delegation.
            const attachments = attachmentIndex === undefined || attachmentIndex === null
                ? []
                : listConversationAttachments(conversationId)
            let attachmentParts: ContentPart[] | undefined
            if (attachments.length) {
                const loadAttachment = Number.isInteger(attachmentIndex) && attachmentIndex! >= 1
                    ? attachments[attachmentIndex! - 1]
                    : undefined
                if (!loadAttachment) {
                    return {
                        success: false,
                        output: '',
                        error: `Attachment index ${attachmentIndex} does not exist in this conversation (${attachments.length} attachment${attachments.length === 1 ? '' : 's'} available). Omit attachmentIndex if the sub-agent does not need an attachment.`,
                    }
                }
                attachmentParts = loadAttachment()
            }
            const content: ChatMessage['content'] = attachmentParts
                ? [{ type: 'text', text: userMessage }, ...attachmentParts]
                : userMessage
            const history: ChatMessage[] = [{ role: 'user', content }]
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
        timeout: SUB_AGENT_TOOL_TIMEOUT_MS,
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
