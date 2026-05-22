import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { getEventBus } from '../telemetry/event-bus.js'
import { getHITLGate } from './hitl-gate.js'
import { trimMessagesToContextLimit, estimateTotalTokens, type ContextStrategy } from './context-trimmer.js'
import type { LLMGateway } from '../gateway/gateway.js'
import type { ChatMessage, ToolCall, ToolDefinition, ToolResult } from '../gateway/providers/base.provider.js'
import { materializeImageArtifacts } from '../artifacts/image-artifacts.js'
import { isOrchestrationToolName } from '../tools/builtin/orchestration-tools.js'
import { ensureOrchestrationStarted, reconcileOrchestrationAfterToolBatch } from './orchestration-state.js'

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
    /** LLM temperature (default: provider default) */
    temperature?: number
    /** Enable reasoning/thinking tokens (default: true) */
    thinkingEnabled?: boolean
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
    /** Pre-trim estimated token count from the caller.
     *  Used as starting floor so the context indicator never drops after trimming. */
    initialContextEstimate?: number
    /** Context window management strategy (default: 'sliding-window') */
    contextStrategy?: ContextStrategy
    /** Mutable set populated with tool names invoked during this execution turn. */
    usedToolNames?: Set<string>
    /** Durable orchestration run for the top-level chat executor. */
    orchestrationRunId?: string
}

export interface AgentExecutorResult {
    /** Final text response from the LLM */
    content: string
    /** Token usage from the last LLM call */
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
    /** Total tokens from the last LLM round (accurate context window usage) */
    contextTokens?: number
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
    /** Artifact URLs for UI display */
    images?: string[]
    /** Base64 data-URL images for LLM vision */
    imageDataUrls?: string[]
}

type Usage = AgentExecutorResult['usage']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function accumulateUsage(prev: Usage, next: Usage): Usage {
    if (!next) return prev
    if (!prev) return next
    return {
        promptTokens: prev.promptTokens + next.promptTokens,
        completionTokens: prev.completionTokens + next.completionTokens,
        totalTokens: prev.totalTokens + next.totalTokens,
    }
}

/** Returns `candidate` if it exceeds `current`, otherwise returns `current`. */
function maxTokens(current: number | undefined, candidate: number | undefined): number | undefined {
    if (candidate == null) return current
    if (current == null) return candidate
    return candidate > current ? candidate : current
}

// ---------------------------------------------------------------------------
// AgentExecutor
// ---------------------------------------------------------------------------

/**
 * Shared agent execution engine.
 * Implements a direct tool-calling loop with streaming, optional HITL approval,
 * DB persistence, and EventBus emissions for the agent timeline.
 *
 * Used by chat, cron, and future trigger types.
 */
export class AgentExecutor {
    private config: Required<Pick<AgentExecutorConfig, 'hitl' | 'maxRounds' | 'saveMessages' | 'streamMode' | 'emitEvents'>> & AgentExecutorConfig
    private _streamId: string
    private _sp: string

    /** The primary streamId (useful for callers that need it for cancel/error handling). */
    get streamId(): string { return this._streamId }

    constructor(config: AgentExecutorConfig) {
        this.config = {
            hitl: false,
            maxRounds: 15,
            saveMessages: true,
            streamMode: 'single',
            emitEvents: true,
            ...config,
        }
        this._streamId = config.streamId ?? nanoid()
        this._sp = config.streamEventPrefix ?? 'chat:stream'
    }

    // -------------------------------------------------------------------------
    // Public entry point
    // -------------------------------------------------------------------------

    /**
     * Run the agent execution loop.
     * Streams the initial LLM response, then executes tool calls in a loop
     * until the LLM responds without tool calls or max rounds is reached.
     */
    async run(messages: ChatMessage[]): Promise<AgentExecutorResult> {
        const { conversationId } = this.config
        const taskId = nanoid()

        let currentMessages = [...messages]
        let fullContent = ''
        let fullThinking = ''
        let lastRoundThinking = ''
        const collectedImages: string[] = []
        let usage: Usage
        let contextTokens = this.config.initialContextEstimate
        let pendingToolCalls: ToolCall[] | undefined
        let toolRounds = 0

        const primaryStreamId = this._streamId
        let activeStreamId = primaryStreamId

        // --- Phase 1: Initial LLM streaming response ---
        this.broadcastStreamStart(activeStreamId)

        const initialResult = await this.consumeStream(
            this.createStream(currentMessages),
            activeStreamId,
        )

        if (initialResult.error) {
            // Always close the stream before re-throwing so the frontend's
            // streaming message isn't left open for the next stream to reuse.
            this.broadcastStreamEnd(activeStreamId, { cancelled: this.config.signal?.aborted })
            throw initialResult.error
        }

        fullContent = initialResult.content
        fullThinking = initialResult.thinking
        lastRoundThinking = initialResult.thinking
        collectedImages.push(...initialResult.images)
        pendingToolCalls = initialResult.toolCalls
        usage = initialResult.usage
        contextTokens = maxTokens(contextTokens, usage?.totalTokens)
        this.maybeUpdateContextTokens(conversationId, contextTokens)

        // No tool calls → done
        if (!pendingToolCalls?.length) {
            this.broadcastStreamEnd(activeStreamId, { usage, model: this.config.model, contextTokens })
            return this.buildResult(fullContent, fullThinking, usage, contextTokens, 0, collectedImages)
        }

        // --- Phase 2: Tool-calling loop ---
        if (this.config.streamMode === 'per-round') {
            this.broadcastStreamEnd(activeStreamId)
        }

        this.emit('task:started', { taskId, conversationId })

        const hitlGate = this.config.hitl ? getHITLGate() : null

        try {
            for (let round = 0; round < this.config.maxRounds && pendingToolCalls?.length; round++) {
                if (this.config.signal?.aborted) break
                toolRounds = round + 1
                const visibleToolCalls = pendingToolCalls.filter((tc) => !isOrchestrationToolName(tc.function.name))
                const hasOrchestrationUpdate = pendingToolCalls.some((tc) => isOrchestrationToolName(tc.function.name))

                if (visibleToolCalls.length) {
                    if (!hasOrchestrationUpdate) {
                        this.ensureOrchestrationVisible(visibleToolCalls)
                    }
                    this.emit('step:status', { taskId, conversationId, iteration: round + 1, status: 'choosing-tools', message: 'Selecting tools...' })
                    this.emit('step:tools-chosen', {
                        taskId, conversationId, iteration: round + 1,
                        toolCalls: visibleToolCalls.map(tc => ({ name: tc.function.name, arguments: tc.function.arguments }))
                    })
                }

                // HITL approval
                if (hitlGate && visibleToolCalls.length) {
                    const roundResult = await this.handleHITL(hitlGate, taskId, pendingToolCalls, currentMessages, activeStreamId, round, fullContent, usage, contextTokens)
                    if (roundResult) {
                        // HITL was denied — update state and continue to the next round
                        ; ({ fullContent, lastRoundThinking, pendingToolCalls, usage, contextTokens, activeStreamId } = roundResult)
                        fullThinking += roundResult.lastRoundThinking
                        collectedImages.push(...roundResult.images)
                        this.maybeUpdateContextTokens(conversationId, contextTokens)
                        continue
                    }
                    // If roundResult is null, approval was granted — fall through to execution
                }

                // Save assistant message (thinking + tool calls) before executing tools
                // so timestamps precede any sub-agent messages produced during execution.
                if (this.config.saveMessages) {
                    this.saveAssistantToolCallMessage(conversationId, fullContent, lastRoundThinking, pendingToolCalls)
                }

                if (visibleToolCalls.length) {
                    this.emit('step:status', { taskId, conversationId, iteration: round + 1, status: 'executing', message: `Executing ${visibleToolCalls.length} tool(s)...` })
                }

                const toolResults = await this.executeToolCalls(pendingToolCalls)

                for (const tr of toolResults) {
                    if (tr.images?.length) collectedImages.push(...tr.images)
                }

                const visibleToolResults = toolResults.filter((tr) => !isOrchestrationToolName(tr.name))
                if (visibleToolResults.length) {
                    this.emit('step:executed', {
                        taskId, conversationId, iteration: round + 1,
                        results: visibleToolResults.map(tr => ({ name: tr.name, success: tr.success, output: tr.output, images: tr.images, imageDataUrls: tr.imageDataUrls }))
                    })
                    if (!hasOrchestrationUpdate) {
                        this.reconcileOrchestrationProgress(visibleToolResults)
                    }
                }

                if (this.config.saveMessages) {
                    this.saveToolResultMessages(conversationId, toolResults)
                }

                // Append tool results to context (with multimodal content for LLM vision)
                currentMessages.push(
                    { role: 'assistant', content: fullContent || '', toolCalls: pendingToolCalls },
                    ...toolResults.map(tr => ({
                        role: 'tool' as const,
                        content: tr.imageDataUrls?.length
                            ? [
                                { type: 'text' as const, text: tr.output },
                                ...tr.imageDataUrls.map(url => ({ type: 'image_url' as const, image_url: { url } })),
                            ]
                            : tr.output,
                        toolCallId: tr.toolCallId,
                    }))
                )

                currentMessages = this.maybeTrimContext(currentMessages)
                contextTokens = maxTokens(contextTokens, estimateTotalTokens(currentMessages))

                const roundResult = await this.streamLLMRound(currentMessages, activeStreamId)
                fullContent = roundResult.content
                fullThinking += roundResult.thinking
                lastRoundThinking = roundResult.thinking
                collectedImages.push(...roundResult.images)
                pendingToolCalls = roundResult.toolCalls
                contextTokens = maxTokens(contextTokens, roundResult.usage?.totalTokens)
                usage = accumulateUsage(usage, roundResult.usage)
                if (this.config.streamMode === 'per-round') activeStreamId = roundResult.streamId

                // Broadcast accumulated usage after each round so the client can update
                // the context circle without waiting for the full turn to end.
                if (usage) {
                    this.config.broadcast(`${this._sp}-usage`, {
                        conversationId, usage, model: this.config.model,
                        contextWindow: this.config.contextWindow, contextTokens,
                    })
                }
                this.maybeUpdateContextTokens(conversationId, contextTokens)
            }
        } finally {
            // Guarantee stream-end is always sent even if an error escapes the loop
            this.broadcastStreamEnd(activeStreamId, {
                usage, model: this.config.model, contextTokens,
                images: collectedImages.length ? collectedImages : undefined,
            })
            this.emit('task:completed', { taskId, conversationId })
        }

        return this.buildResult(fullContent || '(completed)', lastRoundThinking, usage, contextTokens, toolRounds, collectedImages)
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private buildResult(
        content: string,
        thinking: string,
        usage: Usage,
        contextTokens: number | undefined,
        toolRounds: number,
        images: string[],
    ): AgentExecutorResult {
        return { content, usage, contextTokens, toolRounds, images, thinking, provider: this.config.providerId, model: this.config.model }
    }

    /** Emit an EventBus event if emission is enabled, merging eventMeta if configured. */
    private emit(event: string, payload: Record<string, unknown>): void {
        if (!this.config.emitEvents) return
        const meta = this.config.eventMeta
        getEventBus().emit(event, meta ? { ...payload, ...meta } : payload)
    }

    private broadcastStreamStart(streamId: string): void {
        this.config.broadcast(`${this._sp}-start`, {
            streamId,
            conversationId: this.config.conversationId,
            agentId: this.config.agentId,
            agentName: this.config.agentName,
            agentIconUrl: this.config.agentIconUrl,
        })
    }

    private broadcastStreamEnd(streamId: string, extra: Record<string, unknown> = {}): void {
        this.config.broadcast(`${this._sp}-end`, {
            streamId,
            conversationId: this.config.conversationId,
            contextWindow: this.config.contextWindow,
            ...extra,
        })
    }

    /**
     * Persist the current context token count on the conversation row so it
     * survives chat switches and page reloads mid-execution.
     * Only the main-agent executor persists — sub-agents share the conversationId
     * but should not overwrite the main agent's context usage.
     */
    private maybeUpdateContextTokens(conversationId: string, tokens: number | undefined): void {
        if (tokens == null || this._sp !== 'chat:stream') return
        try {
            getDb().prepare('UPDATE conversations SET last_context_tokens = ? WHERE id = ?').run(tokens, conversationId)
        } catch { /* best-effort — don't crash the execution loop */ }
    }

    /**
     * Trim context messages if a context window limit is configured.
     */
    private maybeTrimContext(messages: ChatMessage[]): ChatMessage[] {
        if (!this.config.contextWindow) return messages
        return trimMessagesToContextLimit(messages, this.config.contextWindow, undefined, this.config.contextStrategy)
    }

    /**
     * Create a gateway stream from the current messages, with old images trimmed.
     */
    private createStream(messages: ChatMessage[]) {
        const { gateway, tools, model, temperature, thinkingEnabled, signal, providerId } = this.config
        return gateway.streamComplete(
            {
                messages: AgentExecutor.trimOldImages(messages),
                model,
                tools: tools.length ? tools : undefined,
                temperature,
                thinkingEnabled,
                signal,
            },
            providerId
        )
    }

    /**
     * Handle HITL approval for a round's pending tool calls.
     * Returns updated round state if approval was denied (so the loop can `continue`),
     * or `null` if approved (so execution proceeds normally).
     */
    private async handleHITL(
        hitlGate: ReturnType<typeof getHITLGate>,
        taskId: string,
        pendingToolCalls: ToolCall[],
        currentMessages: ChatMessage[],
        activeStreamId: string,
        round: number,
        fullContent: string,
        usage: Usage,
        contextTokens: number | undefined,
    ): Promise<{
        fullContent: string
        lastRoundThinking: string
        pendingToolCalls: ToolCall[] | undefined
        usage: Usage
        contextTokens: number | undefined
        activeStreamId: string
        images: string[]
    } | null> {
        const { conversationId, signal } = this.config

        this.emit('step:status', { taskId, conversationId, iteration: round + 1, status: 'awaiting-approval', message: 'Checking tool approvals...' })

        const approval = await hitlGate.requestApproval(taskId, pendingToolCalls, signal, conversationId)
        if (approval.approved) return null

        this.emit('step:hitl-denied', { taskId, conversationId, iteration: round + 1, reason: approval.reason })

        const reason = approval.reason?.trim()
        currentMessages.push(
            { role: 'assistant', content: fullContent || '', toolCalls: pendingToolCalls },
            ...pendingToolCalls.map(tc => ({
                role: 'tool' as const,
                content: reason
                    ? `[DENIED] User rejected this tool call. Reason: "${reason}"`
                    : `[DENIED] User rejected this tool call.`,
                toolCallId: tc.id,
            })),
            {
                role: 'user' as const,
                content: reason
                    ? `I denied that action because: ${reason}. Please take a completely different approach that respects this constraint, or answer directly from what you already know.`
                    : `I denied that tool call. Please take a different approach or answer directly. Do not retry the denied tool(s).`,
            }
        )

        const updatedContextTokens = maxTokens(contextTokens, estimateTotalTokens(currentMessages))
        const trimmedMessages = this.maybeTrimContext(currentMessages)

        const result = await this.streamLLMRound(trimmedMessages, activeStreamId)
        return {
            fullContent: result.content,
            lastRoundThinking: result.thinking,
            pendingToolCalls: result.toolCalls,
            usage: accumulateUsage(usage, result.usage),
            contextTokens: maxTokens(updatedContextTokens, result.usage?.totalTokens),
            activeStreamId: this.config.streamMode === 'per-round' ? result.streamId : activeStreamId,
            images: result.images,
        }
    }

    /**
     * Consume a streaming LLM response, broadcasting chunks and accumulating results.
     * Returns partial state on error (via `error` field) so callers can handle
     * errors differently (Phase 1 re-throws, tool rounds recover gracefully).
     */
    private async consumeStream(
        stream: AsyncIterable<import('../gateway/providers/base.provider.js').StreamChunk>,
        streamId: string,
    ): Promise<{
        content: string
        thinking: string
        images: string[]
        toolCalls: ToolCall[] | undefined
        usage: Usage
        error?: Error
    }> {
        const { broadcast, conversationId } = this.config
        let content = ''
        let thinking = ''
        const images: string[] = []
        let toolCalls: ToolCall[] | undefined
        let usage: Usage

        try {
            for await (const chunk of stream) {
                if (chunk.content) {
                    content += chunk.content
                    broadcast(`${this._sp}-chunk`, { streamId, conversationId, content: chunk.content })
                    this.emit('step:content', { conversationId, content: chunk.content })
                }
                if (chunk.thinking) {
                    thinking += chunk.thinking
                    broadcast(`${this._sp}-thinking`, { streamId, conversationId, thinking: chunk.thinking })
                    this.emit('step:thinking', { conversationId, thinking: chunk.thinking })
                }
                if (chunk.images?.length) {
                    let artifactUrls = chunk.images
                    try {
                        const artifacts = await materializeImageArtifacts(chunk.images, conversationId)
                        artifactUrls = artifacts.map((artifact) => artifact.url)
                    } catch (err) {
                        console.warn('[artifacts] Failed to materialize generated image:', err instanceof Error ? err.message : err)
                    }
                    images.push(...artifactUrls)
                    broadcast(`${this._sp}-images`, { streamId, conversationId, images: artifactUrls })
                }
                if (chunk.toolCalls?.length) toolCalls = chunk.toolCalls
                if (chunk.usage) usage = chunk.usage
                if (chunk.done) break
            }
        } catch (err) {
            return { content, thinking, images, toolCalls, usage, error: err as Error }
        }

        return { content, thinking, images, toolCalls, usage }
    }

    /**
     * Stream a single LLM round and return the result.
     * In 'single' mode: resets the existing stream and reuses the streamId.
     * In 'per-round' mode: creates a new streamId.
     */
    private async streamLLMRound(
        messages: ChatMessage[],
        currentStreamId: string,
    ): Promise<{
        content: string
        thinking: string
        images: string[]
        toolCalls: ToolCall[] | undefined
        usage: Usage
        streamId: string
    }> {
        const { conversationId } = this.config

        let streamId = currentStreamId
        if (this.config.streamMode === 'per-round') {
            streamId = nanoid()
            this.broadcastStreamStart(streamId)
        } else {
            this.config.broadcast(`${this._sp}-reset`, { streamId, conversationId })
        }

        const result = await this.consumeStream(this.createStream(messages), streamId)

        if (result.error) {
            if (this.config.signal?.aborted) throw result.error
            // Transient stream failure — return partial content so the loop exits gracefully
            if (!result.content) result.content = `[Stream interrupted: ${result.error.message}]`
        }

        if (this.config.streamMode === 'per-round') {
            this.broadcastStreamEnd(streamId)
        }

        return { content: result.content, thinking: result.thinking, images: result.images, toolCalls: result.toolCalls, usage: result.usage, streamId }
    }

    /**
     * Limit images in the conversation context to only the last N occurrences.
     * Older `image_url` parts are replaced with a short text placeholder so the
     * LLM still knows an image was present. This keeps token usage manageable
     * while preserving recent visual context.
     *
     * BUG FIX: The original walked messages in reverse but counted `kept` from the
     * end, which caused the *earliest* images to be kept rather than the latest.
     * The fix is a simple forward pass: collect all image positions, then replace
     * any that fall outside the last `keep` slots.
     */
    private static trimOldImages(messages: ChatMessage[], keep = 3): ChatMessage[] {
        // Collect all (messageIndex, partIndex) positions of image_url parts
        type ImagePos = { msgIdx: number; partIdx: number }
        const positions: ImagePos[] = []
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i]
            if (!Array.isArray(msg.content)) continue
            for (let j = 0; j < msg.content.length; j++) {
                if (msg.content[j].type === 'image_url') positions.push({ msgIdx: i, partIdx: j })
            }
        }

        if (positions.length <= keep) return messages

        // The positions to replace are all but the last `keep`
        const toReplace = new Set(positions.slice(0, positions.length - keep).map(p => `${p.msgIdx}:${p.partIdx}`))

        return messages.map((msg, i) => {
            if (!Array.isArray(msg.content)) return msg
            const newParts = msg.content.map((part, j) =>
                toReplace.has(`${i}:${j}`) ? { type: 'text' as const, text: '[image omitted from context]' } : part
            )
            // Avoid allocating a new message object if nothing changed
            return newParts === msg.content ? msg : { ...msg, content: newParts }
        })
    }

    /** Execute an array of tool calls concurrently and return results in original order. */
    private async executeToolCalls(toolCalls: ToolCall[]): Promise<ToolCallResult[]> {
        for (const tc of toolCalls) {
            if (!isOrchestrationToolName(tc.function.name)) {
                this.config.usedToolNames?.add(tc.function.name)
            }
        }
        return Promise.all(toolCalls.map(tc => this.executeSingleToolCall(tc)))
    }

    private async executeSingleToolCall(tc: ToolCall): Promise<ToolCallResult> {
        const { signal } = this.config
        try {
            const args = JSON.parse(tc.function.arguments)
            const tool = this.config.tools.find(t => t.name === tc.function.name)

            if (!tool) {
                return { toolCallId: tc.id, name: tc.function.name, output: `Error: Unknown tool "${tc.function.name}"`, success: false }
            }

            let execPromise = tool.execute(args)
            const timeoutSignal = AbortSignal.timeout(tool.timeout)
            const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
            execPromise = Promise.race([
                execPromise,
                new Promise<never>((_, reject) => {
                    const onAbort = () => reject(new Error(
                        signal?.aborted
                            ? 'Tool execution cancelled'
                            : `Tool "${tc.function.name}" timed out after ${Math.round(tool.timeout / 1000)}s`
                    ))
                    if (combined.aborted) { onAbort(); return }
                    combined.addEventListener('abort', onAbort, { once: true })
                })
            ])

            const res = await execPromise
            if (typeof res === 'string') {
                return { toolCallId: tc.id, name: tc.function.name, output: res, success: true }
            }
            if (res?.loadedTools?.length) {
                this.addLoadedTools(res.loadedTools)
            }
            const images = await this.materializeToolImages(res)
            return {
                toolCallId: tc.id,
                name: tc.function.name,
                output: res?.output ?? JSON.stringify(res),
                success: res?.success !== false,
                images,
                imageDataUrls: res?.imageDataUrls,
            }
        } catch (err) {
            return { toolCallId: tc.id, name: tc.function.name, output: `Error: ${(err as Error).message}`, success: false }
        }
    }

    private async materializeToolImages(res: ToolResult | undefined): Promise<string[] | undefined> {
        const sources = res?.images?.length ? res.images : res?.imageDataUrls
        if (!sources?.length) return undefined

        try {
            const artifacts = await materializeImageArtifacts(sources, this.config.conversationId)
            return artifacts.map((artifact) => artifact.url)
        } catch (err) {
            console.warn('[artifacts] Failed to materialize tool image:', err instanceof Error ? err.message : err)
            const nonInlineImages = res?.images?.filter((source) => !source.startsWith('data:'))
            return nonInlineImages?.length ? nonInlineImages : undefined
        }
    }

    private addLoadedTools(tools: ToolDefinition[]): void {
        const existingNames = new Set(this.config.tools.map(tool => tool.name))

        for (const tool of tools) {
            if (existingNames.has(tool.name)) continue
            this.config.tools.push(tool)
            existingNames.add(tool.name)
        }
    }

    private reconcileOrchestrationProgress(results: ToolCallResult[]): void {
        const runId = this.config.orchestrationRunId
        if (!runId || this._sp !== 'chat:stream') return
        const success = results.every((result) => result.success)
        const failed = results.find((result) => !result.success)
        reconcileOrchestrationAfterToolBatch(runId, {
            success,
            note: success ? undefined : failed?.output,
        })
    }

    private ensureOrchestrationVisible(toolCalls: ToolCall[]): void {
        const runId = this.config.orchestrationRunId
        if (!runId || this._sp !== 'chat:stream') return
        ensureOrchestrationStarted(runId, this.describeToolBatch(toolCalls))
    }

    private describeToolBatch(toolCalls: ToolCall[]): string {
        if (toolCalls.length > 1) return `Execute ${toolCalls.length} tool actions`
        const tc = toolCalls[0]
        const toolName = tc.function.name.replace(/^delegate_to_/, '').replace(/_agent$/, '').replace(/_/g, ' ')
        try {
            const args = JSON.parse(tc.function.arguments) as Record<string, unknown>
            const text = [args.instructions, args.query, args.url, args.path, args.filePath]
                .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
            if (text) return text.trim().slice(0, 120)
        } catch {
            // Ignore malformed tool args; fall back to the tool name.
        }
        return `Run ${toolName}`
    }

    /** Save the assistant's tool-calling message (thinking + content + tool_calls) to DB. */
    private saveAssistantToolCallMessage(
        conversationId: string,
        assistantContent: string,
        thinking: string,
        toolCalls: ToolCall[],
    ): void {
        const { agentId, providerId, model } = this.config
        const visibleToolCalls = toolCalls.filter((tc) => !isOrchestrationToolName(tc.function.name))
        if (!visibleToolCalls.length) return
        getDb().prepare(
            'INSERT INTO messages (id, conversation_id, role, content, thinking, tool_calls_json, agent_id, provider, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(nanoid(), conversationId, 'assistant', assistantContent || '', thinking || null, JSON.stringify(visibleToolCalls), agentId || null, providerId || null, model || null, Date.now())
    }

    /** Save tool result messages to DB and broadcast them to the UI. */
    private saveToolResultMessages(conversationId: string, results: ToolCallResult[]): void {
        const { broadcast, agentId, agentName, agentIconUrl } = this.config
        const db = getDb()
        for (const tr of results) {
            if (isOrchestrationToolName(tr.name)) continue
            const toolMsgId = nanoid()
            const now = Date.now()
            db.prepare(
                'INSERT INTO messages (id, conversation_id, role, content, tool_call_id, image_urls_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
            ).run(toolMsgId, conversationId, 'tool', tr.output, tr.toolCallId, tr.images?.length ? JSON.stringify(tr.images) : null, now)

            broadcast('chat:new-message', {
                conversationId,
                message: {
                    id: toolMsgId, conversationId, role: 'tool', content: tr.output,
                    agentId, agentName, agentIconUrl,
                    imageDataUrls: tr.images,
                    createdAt: now,
                },
            })
        }
    }
}
