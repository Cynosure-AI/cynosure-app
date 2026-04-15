import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { getEventBus } from '../telemetry/event-bus.js'
import { getHITLGate } from './hitl-gate.js'
import type { LLMGateway } from '../gateway/gateway.js'
import type { ChatMessage, ContentPart, ToolCall, ToolDefinition } from '../gateway/providers/base.provider.js'

type BroadcastFn = (event: string, data: unknown) => void

export interface AgentExecutorConfig {
    /** LLM gateway instance */
    gateway: LLMGateway
    /** Tools available for the agent */
    tools: ToolDefinition[]
    /** Conversation ID to save messages and emit events for */
    conversationId: string
    /** WebSocket broadcast function for streaming to UI */
    broadcast: BroadcastFn
    /** Provider ID override */
    providerId?: string
    /** Model override */
    model?: string
    /** Whether to require HITL approval for tool calls (default: false) */
    hitl?: boolean
    /** Maximum number of tool-calling rounds (default: 15) */
    maxRounds?: number
    /** Maximum characters for a single tool output before truncation (default: 16384). Set 0 to disable. */
    maxToolOutputChars?: number
    /** LLM temperature (default: provider default) */
    temperature?: number
    /** AbortSignal for cancellation */
    signal?: AbortSignal
    /** Whether to save messages to the database (default: true) */
    saveMessages?: boolean
    /**
     * Stream mode for multi-round tool calls:
     * - 'single': Keeps one streamId across all rounds, uses stream-reset between rounds (chat-style)
     * - 'per-round': Creates a new streamId per round (cron-style)
     * Default: 'single'
     */
    streamMode?: 'single' | 'per-round'
    /** Caller-provided streamId (used in single mode so the caller can reference it for cancel/error handling). Generated internally if not provided. */
    streamId?: string
    /** Agent identity — attached to stream events and saved messages for attribution (e.g. MA sub-agents) */
    agentId?: string
    agentName?: string
    agentIconUrl?: string | null
    /** Whether to emit EventBus execution step events (default: true). Set to false for sub-agent executors to avoid polluting the parent timeline. */
    emitEvents?: boolean
    /** Extra metadata to merge into all emitted EventBus events (e.g. { maCodename, maAgentName } for sub-agent attribution) */
    eventMeta?: Record<string, unknown>
    /**
     * Prefix for broadcast stream events (default: 'chat:stream').
     * Sub-agents use 'chat:subagent-stream' so the UI can handle them
     * with dedicated handlers that don't interfere with primary stream state.
     */
    streamEventPrefix?: string
    /** Context window size (max tokens) for the model being used.
     *  Included in stream-end events so the UI can display context usage. */
    contextWindow?: number
}

export interface AgentExecutorResult {
    /** Final text response from the LLM */
    content: string
    /** Token usage from the last LLM call */
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
    /** Number of tool-calling rounds executed */
    toolRounds: number
    /** Collected images from tool results */
    images: string[]
    /** Thinking content from the LLM */
    thinking: string
    /** Provider ID used for the LLM call */
    provider?: string
    /** Model name used for the LLM call */
    model?: string
}

interface ToolCallResult {
    toolCallId: string
    name: string
    output: string
    success: boolean
    /** File-path URLs for UI display */
    images?: string[]
    /** Base64 data-URL images for LLM vision */
    imageDataUrls?: string[]
}

/** Accumulate token usage across multiple LLM rounds (tool-calling loop). */
function accumulateUsage(
    prev: AgentExecutorResult['usage'],
    next: AgentExecutorResult['usage']
): AgentExecutorResult['usage'] {
    if (!next) return prev
    if (!prev) return next
    return {
        promptTokens: prev.promptTokens + next.promptTokens,
        completionTokens: prev.completionTokens + next.completionTokens,
        totalTokens: prev.totalTokens + next.totalTokens,
    }
}

/**
 * Shared agent execution engine.
 * Implements a direct tool-calling loop with streaming, optional HITL approval,
 * DB persistence, and EventBus emissions for the agent timeline.
 *
 * Used by chat, cron, and future trigger types.
 */
export class AgentExecutor {
    private config: Required<Pick<AgentExecutorConfig, 'hitl' | 'maxRounds' | 'maxToolOutputChars' | 'saveMessages' | 'streamMode' | 'emitEvents'>> & AgentExecutorConfig
    private _streamId: string
    /** Buffer for truncated tool outputs — keyed by toolCallId */
    private longOutputs = new Map<string, string>()

    /** The primary streamId (useful for callers that need it for cancel/error handling). */
    get streamId(): string { return this._streamId }

    /**
     * Limit images in the conversation context to only the last N occurrences.
     * Older image_url parts are replaced with a short text placeholder so the
     * LLM still knows an image was there. This keeps token usage manageable
     * while preserving recent visual context.
     */
    private static trimOldImages(messages: ChatMessage[], keep = 3): ChatMessage[] {
        // First pass: count total images
        let totalImages = 0
        for (const msg of messages) {
            if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (part.type === 'image_url') totalImages++
                }
            }
        }
        if (totalImages <= keep) return messages

        // Second pass (reverse): keep the last `keep` images, replace rest with placeholder
        let kept = 0
        const result: ChatMessage[] = [...messages]
        for (let i = result.length - 1; i >= 0; i--) {
            const msg = result[i]
            if (!Array.isArray(msg.content)) continue

            let modified = false
            const newParts: ContentPart[] = []
            // Walk parts in reverse so we keep the last ones encountered
            for (let j = msg.content.length - 1; j >= 0; j--) {
                const part = msg.content[j]
                if (part.type === 'image_url') {
                    if (kept < keep) {
                        newParts.unshift(part)
                        kept++
                    } else {
                        newParts.unshift({ type: 'text', text: '[image omitted from context]' })
                        modified = true
                    }
                } else {
                    newParts.unshift(part)
                }
            }
            if (modified) {
                result[i] = { ...msg, content: newParts }
            }
        }
        return result
    }

    constructor(config: AgentExecutorConfig) {
        this.config = {
            hitl: false,
            maxRounds: 15,
            maxToolOutputChars: 16_384,
            saveMessages: true,
            streamMode: 'single',
            emitEvents: true,
            ...config
        }
        this._streamId = config.streamId || nanoid()
        this._sp = config.streamEventPrefix || 'chat:stream'
    }

    /** Resolved stream event prefix (e.g. 'chat:stream' or 'chat:subagent-stream') */
    private _sp: string

    /**
     * Run the agent execution loop.
     * Streams the initial LLM response, then executes tool calls in a loop
     * until the LLM responds without tool calls or max rounds is reached.
     */
    async run(messages: ChatMessage[]): Promise<AgentExecutorResult> {
        const { gateway, tools, conversationId, broadcast, providerId, model, signal, temperature } = this.config
        const eventBus = getEventBus()
        const shouldEmit = this.config.emitEvents
        const meta = this.config.eventMeta
        const emit = (event: string, ...args: unknown[]) => {
            if (shouldEmit) {
                if (meta && args.length && typeof args[0] === 'object' && args[0] !== null) {
                    eventBus.emit(event, { ...args[0] as Record<string, unknown>, ...meta })
                } else {
                    eventBus.emit(event, ...args)
                }
            }
        }
        const taskId = nanoid()

        let currentMessages = [...messages]
        let fullContent = ''
        let fullThinking = ''
        let lastRoundThinking = ''
        const collectedImages: string[] = []
        let usage: AgentExecutorResult['usage']
        let lastRoundTotalTokens: number | undefined
        let pendingToolCalls: ToolCall[] | undefined
        let toolRounds = 0

        // --- Phase 1: Initial LLM streaming response ---
        const primaryStreamId = this._streamId
        let activeStreamId = primaryStreamId

        broadcast(`${this._sp}-start`, {
            streamId: activeStreamId,
            conversationId,
            agentId: this.config.agentId,
            agentName: this.config.agentName,
            agentIconUrl: this.config.agentIconUrl
        })

        const initialStream = gateway.streamComplete(
            {
                messages: AgentExecutor.trimOldImages(currentMessages),
                model,
                tools: tools.length ? tools : undefined,
                temperature,
                signal
            },
            providerId
        )

        try {
            for await (const chunk of initialStream) {
                if (chunk.content) {
                    fullContent += chunk.content
                    broadcast(`${this._sp}-chunk`, { streamId: activeStreamId, conversationId, content: chunk.content })
                    emit('step:content', { conversationId, content: chunk.content })
                }
                if (chunk.thinking) {
                    fullThinking += chunk.thinking
                    lastRoundThinking += chunk.thinking
                    broadcast(`${this._sp}-thinking`, { streamId: activeStreamId, conversationId, thinking: chunk.thinking })
                    emit('step:thinking', { conversationId, thinking: chunk.thinking })
                }
                if (chunk.images?.length) {
                    collectedImages.push(...chunk.images)
                    broadcast(`${this._sp}-images`, { streamId: activeStreamId, conversationId, images: chunk.images })
                }
                if (chunk.toolCalls?.length) {
                    pendingToolCalls = chunk.toolCalls
                }
                if (chunk.usage) { usage = chunk.usage; lastRoundTotalTokens = chunk.usage.totalTokens }
                if (chunk.done) break
            }
        } catch (err) {
            // Always close the stream on the client before re-throwing, otherwise
            // the frontend's streaming message is left open and a subsequent
            // stream-reset for the outer agent will reuse it (wrong icon/identity).
            broadcast(`${this._sp}-end`, { streamId: activeStreamId, conversationId, cancelled: signal?.aborted })
            throw err
        }

        // No tool calls → done after Phase 1
        if (!pendingToolCalls?.length) {
            broadcast(`${this._sp}-end`, { streamId: activeStreamId, conversationId, usage, model, contextWindow: this.config.contextWindow, lastRoundTotalTokens })
            return { content: fullContent, usage, toolRounds: 0, images: collectedImages, thinking: lastRoundThinking, provider: providerId, model }
        }

        // --- Phase 2: Tool-calling loop ---
        // End Phase 1 stream if per-round mode
        if (this.config.streamMode === 'per-round') {
            broadcast(`${this._sp}-end`, { streamId: activeStreamId, conversationId })
        }

        emit('task:started', { taskId, conversationId })

        const hitlGate = this.config.hitl ? getHITLGate() : null

        for (let round = 0; round < this.config.maxRounds && pendingToolCalls?.length; round++) {
            if (signal?.aborted) break
            toolRounds = round + 1

            // Emit tool calls
            emit('step:status', {
                taskId, conversationId,
                iteration: round + 1,
                status: 'choosing-tools',
                message: 'Selecting tools...'
            })
            emit('step:tools-chosen', {
                taskId, conversationId,
                iteration: round + 1,
                toolCalls: pendingToolCalls.map(tc => ({
                    name: tc.function.name,
                    arguments: tc.function.arguments
                }))
            })

            // HITL approval (if enabled)
            if (hitlGate) {
                emit('step:status', {
                    taskId, conversationId,
                    iteration: round + 1,
                    status: 'awaiting-approval',
                    message: 'Checking tool approvals...'
                })

                const approval = await hitlGate.requestApproval(taskId, pendingToolCalls, signal, conversationId)

                if (!approval.approved) {
                    emit('step:hitl-denied', {
                        taskId, conversationId,
                        iteration: round + 1,
                        reason: approval.reason
                    })

                    const denialReason = approval.reason?.trim()

                    // Tool messages tell the LLM what "the tool returned"
                    currentMessages.push(
                        { role: 'assistant', content: fullContent || '', toolCalls: pendingToolCalls },
                        ...pendingToolCalls.map(tc => ({
                            role: 'tool' as const,
                            content: denialReason
                                ? `[DENIED] User rejected this tool call. Reason: "${denialReason}"`
                                : `[DENIED] User rejected this tool call.`,
                            toolCallId: tc.id
                        }))
                    )

                    // A follow-up user message is far more directive for the LLM than a tool message.
                    // It tells the model exactly what to do next rather than just reporting a failure.
                    currentMessages.push({
                        role: 'user' as const,
                        content: denialReason
                            ? `I denied that action because: ${denialReason}. Please take a completely different approach that respects this constraint, or answer directly from what you already know. Do not retry the denied tool(s).`
                            : `I denied that tool call. Please take a different approach or answer directly. Do not retry the denied tool(s).`
                    })

                    // Stream LLM's revised response
                    const result = await this.streamLLMRound(currentMessages, activeStreamId, round)
                    fullContent = result.content
                    fullThinking += result.thinking
                    collectedImages.push(...result.images)
                    pendingToolCalls = result.toolCalls
                    if (result.usage?.totalTokens) lastRoundTotalTokens = result.usage.totalTokens
                    usage = accumulateUsage(usage, result.usage)
                    if (this.config.streamMode === 'per-round') activeStreamId = result.streamId
                    continue
                }
            }

            // Save the assistant message (thinking + tool calls) BEFORE executing tools
            // so it gets an earlier timestamp than sub-agent messages produced during execution.
            if (this.config.saveMessages) {
                this.saveAssistantToolCallMessage(conversationId, fullContent, lastRoundThinking, pendingToolCalls)
            }

            // Execute tool calls
            emit('step:status', {
                taskId, conversationId,
                iteration: round + 1,
                status: 'executing',
                message: `Executing ${pendingToolCalls.length} tool(s)...`
            })

            const toolCallResults = await this.executeToolCalls(pendingToolCalls)

            // Collect tool result images (base64 data-URLs) so they are
            // available in the final AgentExecutorResult for channel adapters.
            for (const tr of toolCallResults) {
                if (tr.imageDataUrls?.length) collectedImages.push(...tr.imageDataUrls)
            }

            // Emit results
            emit('step:executed', {
                taskId, conversationId,
                iteration: round + 1,
                results: toolCallResults.map(tr => ({
                    name: tr.name,
                    success: tr.success,
                    output: tr.output,
                    images: tr.images,
                    imageDataUrls: tr.imageDataUrls
                }))
            })

            // Save tool result messages AFTER execution
            if (this.config.saveMessages) {
                this.saveToolResultMessages(conversationId, toolCallResults)
            }

            // Truncate oversized tool outputs and buffer the full text
            const limit = this.config.maxToolOutputChars
            for (const tr of toolCallResults) {
                if (limit > 0 && tr.output.length > limit) {
                    this.longOutputs.set(tr.toolCallId, tr.output)
                    tr.output = tr.output.slice(0, limit)
                        + `\n\n[OUTPUT TRUNCATED — original ${this.longOutputs.get(tr.toolCallId)!.length} chars. `
                        + `Use read_long_output tool with toolCallId="${tr.toolCallId}" to access remaining content.]`
                }
            }

            // Inject read_long_output tool dynamically if any outputs were truncated
            if (this.longOutputs.size > 0 && !tools.find(t => t.name === 'read_long_output')) {
                tools.push(this.makeReadLongOutputTool())
            }

            // Append to conversation context (include images as multimodal content for LLM vision)
            currentMessages.push(
                { role: 'assistant', content: fullContent || '', toolCalls: pendingToolCalls },
                ...toolCallResults.map(tr => ({
                    role: 'tool' as const,
                    content: tr.imageDataUrls?.length
                        ? [
                            { type: 'text' as const, text: tr.output },
                            ...tr.imageDataUrls.map(url => ({ type: 'image_url' as const, image_url: { url } }))
                        ]
                        : tr.output,
                    toolCallId: tr.toolCallId
                }))
            )

            // Stream next LLM response
            const result = await this.streamLLMRound(currentMessages, activeStreamId, round)
            fullContent = result.content
            fullThinking += result.thinking
            lastRoundThinking = result.thinking
            collectedImages.push(...result.images)
            pendingToolCalls = result.toolCalls
            if (result.usage?.totalTokens) lastRoundTotalTokens = result.usage.totalTokens
            usage = accumulateUsage(usage, result.usage)
            if (this.config.streamMode === 'per-round') activeStreamId = result.streamId

            // Broadcast accumulated usage after each tool round so the client
            // can update the context circle without waiting for the full turn to end.
            if (usage) {
                broadcast(`${this._sp}-usage`, {
                    conversationId, usage, model, contextWindow: this.config.contextWindow,
                    lastRoundTotalTokens
                })
            }
        }

        // End final stream
        if (this.config.streamMode === 'single') {
            broadcast(`${this._sp}-end`, { streamId: activeStreamId, conversationId, usage, model, contextWindow: this.config.contextWindow, lastRoundTotalTokens })
        } else {
            // per-round: send a final end event with usage so the client gets token counts
            broadcast(`${this._sp}-end`, { streamId: activeStreamId, conversationId, usage, model, contextWindow: this.config.contextWindow, lastRoundTotalTokens })
        }

        emit('task:completed', { taskId, conversationId })

        return {
            content: fullContent || '(completed)',
            usage,
            toolRounds,
            images: collectedImages,
            thinking: lastRoundThinking,
            provider: providerId,
            model
        }
    }

    /**
     * Stream a single LLM round and return the result.
     * In 'single' mode: resets the existing stream and reuses the streamId.
     * In 'per-round' mode: creates a new streamId.
     */
    private async streamLLMRound(
        messages: ChatMessage[],
        currentStreamId: string,
        round: number
    ): Promise<{
        content: string
        thinking: string
        images: string[]
        toolCalls: ToolCall[] | undefined
        usage: AgentExecutorResult['usage']
        streamId: string
    }> {
        const { gateway, tools, conversationId, broadcast, providerId, model, signal, temperature } = this.config

        let streamId = currentStreamId
        if (this.config.streamMode === 'per-round') {
            streamId = nanoid()
            broadcast(`${this._sp}-start`, {
                streamId,
                conversationId,
                agentId: this.config.agentId,
                agentName: this.config.agentName,
                agentIconUrl: this.config.agentIconUrl
            })
        } else {
            broadcast(`${this._sp}-reset`, { streamId, conversationId })
        }

        let content = ''
        let thinking = ''
        const images: string[] = []
        let toolCalls: ToolCall[] | undefined
        let usage: AgentExecutorResult['usage']

        const stream = gateway.streamComplete(
            {
                messages: AgentExecutor.trimOldImages(messages),
                model,
                tools: tools.length ? tools : undefined,
                temperature,
                signal
            },
            providerId
        )

        try {
            for await (const chunk of stream) {
                if (chunk.content) {
                    content += chunk.content
                    broadcast(`${this._sp}-chunk`, { streamId, conversationId, content: chunk.content })
                    if (this.config.emitEvents) {
                        const payload: Record<string, unknown> = { conversationId, content: chunk.content }
                        if (this.config.eventMeta) Object.assign(payload, this.config.eventMeta)
                        getEventBus().emit('step:content', payload)
                    }
                }
                if (chunk.thinking) {
                    thinking += chunk.thinking
                    broadcast(`${this._sp}-thinking`, { streamId, conversationId, thinking: chunk.thinking })
                    if (this.config.emitEvents) {
                        const payload: Record<string, unknown> = { conversationId, thinking: chunk.thinking }
                        if (this.config.eventMeta) Object.assign(payload, this.config.eventMeta)
                        getEventBus().emit('step:thinking', payload)
                    }
                }
                if (chunk.images?.length) {
                    images.push(...chunk.images)
                    broadcast(`${this._sp}-images`, { streamId, conversationId, images: chunk.images })
                }
                if (chunk.toolCalls?.length) {
                    toolCalls = chunk.toolCalls
                }
                if (chunk.usage) usage = chunk.usage
                if (chunk.done) break
            }
        } catch (err) {
            // If the user cancelled, re-throw so the caller can handle it
            if (signal?.aborted) throw err
            // Transient stream failure (timeout, connection drop, provider error).
            // Append any partial content we got and return without tool calls
            // so the executor loop exits gracefully with whatever we accumulated.
            if (!content) {
                content = `[Stream interrupted: ${(err as Error).message}]`
            }
        }

        // In per-round mode, end the stream for this round
        if (this.config.streamMode === 'per-round') {
            broadcast(`${this._sp}-end`, { streamId, conversationId })
        }

        return { content, thinking, images, toolCalls, usage, streamId }
    }

    /** Execute an array of tool calls concurrently and return results in original order. */
    private async executeToolCalls(toolCalls: ToolCall[]): Promise<ToolCallResult[]> {
        const { signal } = this.config
        const promises = toolCalls.map(async (tc): Promise<ToolCallResult> => {
            let output: string
            let success = true
            let images: string[] | undefined
            let imageDataUrls: string[] | undefined
            try {
                const args = JSON.parse(tc.function.arguments)
                const tool = this.config.tools.find(t => t.name === tc.function.name)
                if (tool) {
                    // Enforce tool timeout: combine tool's own timeout with the
                    // parent abort signal so both cancellation and timeouts work.
                    const toolTimeout = tool.timeout > 0 ? tool.timeout : 0
                    let execPromise = tool.execute(args)

                    if (toolTimeout > 0) {
                        const timeoutSignal = AbortSignal.timeout(toolTimeout)
                        const combinedSignal = signal
                            ? AbortSignal.any([signal, timeoutSignal])
                            : timeoutSignal

                        execPromise = Promise.race([
                            execPromise,
                            new Promise<never>((_, reject) => {
                                combinedSignal.addEventListener('abort', () => {
                                    reject(new Error(
                                        signal?.aborted
                                            ? 'Tool execution cancelled'
                                            : `Tool "${tc.function.name}" timed out after ${Math.round(toolTimeout / 1000)}s`
                                    ))
                                }, { once: true })
                                // If already aborted, reject immediately
                                if (combinedSignal.aborted) {
                                    reject(new Error(
                                        signal?.aborted
                                            ? 'Tool execution cancelled'
                                            : `Tool "${tc.function.name}" timed out after ${Math.round(toolTimeout / 1000)}s`
                                    ))
                                }
                            })
                        ])
                    }

                    const res = await execPromise
                    if (typeof res === 'string') {
                        output = res
                    } else {
                        output = res?.output || JSON.stringify(res)
                        if (res?.success === false) success = false
                        images = res?.images
                        imageDataUrls = res?.imageDataUrls
                    }
                } else {
                    output = `Error: Unknown tool "${tc.function.name}"`
                    success = false
                }
            } catch (err) {
                output = `Error: ${(err as Error).message}`
                success = false
            }
            return { toolCallId: tc.id, name: tc.function.name, output, success, images, imageDataUrls }
        })

        return Promise.all(promises)
    }

    /** Save the assistant's tool-calling message (thinking + content + tool_calls) to DB. */
    private saveAssistantToolCallMessage(
        conversationId: string,
        assistantContent: string,
        thinking: string,
        toolCalls: ToolCall[]
    ): void {
        const db = getDb()
        const assistantMsgId = nanoid()
        db.prepare(
            'INSERT INTO messages (id, conversation_id, role, content, thinking, tool_calls_json, agent_id, provider, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(assistantMsgId, conversationId, 'assistant', assistantContent || '', thinking || null, JSON.stringify(toolCalls), this.config.agentId || null, this.config.providerId || null, this.config.model || null, Date.now())
    }

    /** Create the dynamic read_long_output tool for accessing truncated outputs. */
    private makeReadLongOutputTool(): ToolDefinition {
        const chunkSize = this.config.maxToolOutputChars || 16_384
        return {
            name: 'read_long_output',
            description:
                'Read a portion of a previously truncated tool output. ' +
                'Use this when a tool result was truncated and you need to see more of the content.',
            parameters: {
                type: 'object',
                properties: {
                    toolCallId: { type: 'string', description: 'The toolCallId from the truncated output.' },
                    startChar: { type: 'number', description: 'Start character offset (0-based, default 0).' },
                    endChar: { type: 'number', description: `End character offset (exclusive). Max ${chunkSize} chars per read.` }
                },
                required: ['toolCallId']
            },
            timeout: 5_000,
            execute: async (params: unknown) => {
                const { toolCallId, startChar = 0, endChar } = params as { toolCallId: string; startChar?: number; endChar?: number }
                const full = this.longOutputs.get(toolCallId)
                if (!full) return { success: false, output: `No buffered output found for toolCallId "${toolCallId}".` }
                const start = Math.max(0, startChar)
                const end = Math.min(full.length, endChar ?? start + chunkSize)
                const slice = full.slice(start, end)
                return {
                    success: true,
                    output: slice + (end < full.length ? `\n\n[Showing chars ${start}-${end} of ${full.length}. More content available.]` : `\n\n[End of output — chars ${start}-${end} of ${full.length}.]`)
                }
            }
        }
    }

    /** Save tool result messages to DB and broadcast them to the UI. */
    private saveToolResultMessages(
        conversationId: string,
        results: ToolCallResult[]
    ): void {
        const db = getDb()
        const { broadcast } = this.config

        for (const tr of results) {
            const toolMsgId = nanoid()
            const toolNow = Date.now()
            const imageUrlsJson = tr.images?.length ? JSON.stringify(tr.images) : null
            db.prepare(
                'INSERT INTO messages (id, conversation_id, role, content, tool_call_id, image_urls_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
            ).run(toolMsgId, conversationId, 'tool', tr.output, tr.toolCallId, imageUrlsJson, toolNow)

            broadcast('chat:new-message', {
                conversationId,
                message: {
                    id: toolMsgId, conversationId, role: 'tool', content: tr.output,
                    agentId: this.config.agentId, agentName: this.config.agentName, agentIconUrl: this.config.agentIconUrl,
                    imageDataUrls: tr.images,
                    createdAt: toolNow
                }
            })
        }
    }
}
