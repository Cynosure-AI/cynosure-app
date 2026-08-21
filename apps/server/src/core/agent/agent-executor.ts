import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { getEventBus } from '../telemetry/event-bus.js'
import { getHITLGate } from './hitl-gate.js'
import { trimMessagesToContextLimit, estimateTotalTokens, type ContextStrategy } from './context-trimmer.js'
import type { LLMGateway } from '../gateway/gateway.js'
import { IncompleteModelResponseError, type ChatMessage, type ToolCall, type ToolDefinition, type ToolResult, type ToolResultContent } from '../gateway/providers/base.provider.js'
import type { ReasoningEffort } from '@shared/types'
import {
    artifactFileUrlToDataUrl,
    materializeAudioArtifacts,
    materializeImageArtifacts,
} from '../artifacts/image-artifacts.js'
import { isPlanningToolName } from '../tools/builtin/planning-tools.js'
import { isVisibleExecutionTool } from '../tools/tool-policy.js'
import { getPlanningState, reconcilePlanningAfterToolBatch } from './planning-state.js'
import { validateToolArguments } from '../tools/tool-argument-validator.js'
import { recordDebugModelRequest, recordDebugModelResponse } from '../chat/debug-context.js'

/** Maximum tool-use rounds for the main (orchestrator) agent per request. */
export const MAIN_AGENT_MAX_ROUNDS = 50

/** One retry for model-only continuation rounds after tools have already run. */
const MODEL_ROUND_MAX_ATTEMPTS = 2
const OPEN_PLAN_RECOVERY_ATTEMPTS = 1

export class MaxToolRoundsExceededError extends Error {
    constructor(maxRounds: number) {
        super(`Agent exceeded the maximum of ${maxRounds} tool-calling rounds before producing a final response.`)
        this.name = 'MaxToolRoundsExceededError'
    }
}

export class IncompletePlanningRunError extends Error {
    constructor() {
        super('Agent stopped while its planning task list still contained unfinished work.')
        this.name = 'IncompletePlanningRunError'
    }
}

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
    /** Maximum number of tool-calling rounds (default: 50) */
    maxRounds?: number
    /** LLM temperature (default: provider default) */
    temperature?: number
    /** Enable reasoning/thinking tokens (default: true) */
    thinkingEnabled?: boolean
    /** Amount of model reasoning work requested when thinking is enabled. */
    reasoningEffort?: ReasoningEffort
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
    /** Durable planning run for the top-level chat executor. */
    planningRunId?: string
    /** True only for the top-level chat executor that owns conversation-level progress persistence. */
    isPrimaryExecutor?: boolean
    /** Capture model-visible requests and provider-exposed responses for the debug inspector. */
    debugContextEnabled?: boolean
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
    /** Images generated by the model or by non-read-only media tools. */
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
    /** Base64 data-URL audio for multimodal models and UI playback. */
    audioDataUrls?: string[]
    /** Local artifact URLs used for persistence and UI playback. */
    audioArtifacts?: string[]
    /** Whether returned media is newly generated output rather than reference context. */
    generatedMedia?: boolean
    /** Original MCP result values retained for structured consumers. */
    structuredContent?: unknown
    content?: ToolResultContent[]
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

function toolReturnsGeneratedMedia(tool: ToolDefinition): boolean {
    if (tool.execution?.readOnly === true) return false

    // Some MCP servers omit behavior annotations. Keep common inspection and
    // retrieval tools out of generated artifacts even when they return rich
    // media, while recognizing explicit media-generation names first.
    const originalName = (tool as ToolDefinition & { originalName?: string }).originalName || tool.name
    const normalizedName = originalName.toLowerCase()
    if (/(?:generate|create|render|synthesi[sz]e|imagegen|text[_-]to[_-](?:image|speech|audio|video))/.test(normalizedName)) {
        return true
    }
    if (/(?:^|[_-])(?:view|read|inspect|open|get|fetch|download|search|list|retrieve|screenshot|capture)(?:[_-]|$)/.test(normalizedName)) {
        return false
    }
    return true
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
            maxRounds: MAIN_AGENT_MAX_ROUNDS,
            saveMessages: true,
            streamMode: 'single',
            emitEvents: true,
            isPrimaryExecutor: false,
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

        this.config.signal?.throwIfAborted()

        let currentMessages = [...messages]
        let fullContent = ''
        let fullThinking = ''
        let lastRoundThinking = ''
        const collectedImages: string[] = []
        let usage: Usage
        let contextTokens = this.config.initialContextEstimate
        let pendingToolCalls: ToolCall[] | undefined
        let toolRounds = 0
        let openPlanRecoveryAttempts = 0

        const primaryStreamId = this._streamId
        let activeStreamId = primaryStreamId

        // --- Phase 1: Initial LLM streaming response ---
        this.broadcastStreamStart(activeStreamId)

        const initialStream = this.createStream(currentMessages)
        const initialResult = await this.consumeStream(
            initialStream.stream,
            activeStreamId,
            initialStream.debugRoundIndex,
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
        this.publishContextUsage(conversationId, usage, contextTokens)

        if (!pendingToolCalls?.length && this.hasOpenPlanningItems()) {
            openPlanRecoveryAttempts++
            currentMessages = this.withOpenPlanRecoveryPrompt(currentMessages, fullContent)
            let recoveryResult: Awaited<ReturnType<AgentExecutor['streamLLMRound']>>
            try {
                recoveryResult = await this.streamLLMRound(currentMessages, activeStreamId)
            } catch (err) {
                this.broadcastStreamEnd(activeStreamId, { usage, model: this.config.model, contextTokens })
                throw err
            }
            fullContent = recoveryResult.content
            fullThinking += recoveryResult.thinking
            lastRoundThinking = recoveryResult.thinking
            collectedImages.push(...recoveryResult.images)
            pendingToolCalls = recoveryResult.toolCalls
            contextTokens = maxTokens(contextTokens, recoveryResult.usage?.totalTokens)
            usage = accumulateUsage(usage, recoveryResult.usage)
            if (this.config.streamMode === 'per-round') activeStreamId = recoveryResult.streamId
            this.publishContextUsage(conversationId, usage, contextTokens)
            if (!pendingToolCalls?.length && this.hasOpenPlanningItems()) {
                this.broadcastStreamEnd(activeStreamId, { usage, model: this.config.model, contextTokens })
                throw new IncompletePlanningRunError()
            }
        }

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
        let loopCompleted = false

        try {
            for (let round = 0; round < this.config.maxRounds && pendingToolCalls?.length; round++) {
                if (this.config.signal?.aborted) break
                toolRounds = round + 1
                const visibleToolCalls = pendingToolCalls.filter((tc) => isVisibleExecutionTool(tc.function.name))
                const hasPlanningUpdate = pendingToolCalls.some((tc) => isPlanningToolName(tc.function.name))

                if (visibleToolCalls.length) {
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
                        this.publishContextUsage(conversationId, usage, contextTokens)
                        continue
                    }
                    // If roundResult is null, approval was granted — fall through to execution
                }

                // Save assistant message (thinking + tool calls) before executing tools
                // so timestamps precede any sub-agent messages produced during execution.
                if (this.config.saveMessages) {
                    this.saveAssistantToolCallMessage(conversationId, fullContent, lastRoundThinking, pendingToolCalls)
                }
                contextTokens = maxTokens(
                    contextTokens,
                    estimateTotalTokens([
                        ...currentMessages,
                        { role: 'assistant', content: fullContent || '', toolCalls: pendingToolCalls },
                    ])
                )
                this.publishContextUsage(conversationId, usage, contextTokens)

                if (visibleToolCalls.length) {
                    this.emit('step:status', { taskId, conversationId, iteration: round + 1, status: 'executing', message: `Executing ${visibleToolCalls.length} tool(s)...` })
                }

                const toolResults = await this.executeToolCalls(pendingToolCalls)
                this.config.signal?.throwIfAborted()

                for (const tr of toolResults) {
                    if (tr.generatedMedia && tr.images?.length) collectedImages.push(...tr.images)
                }

                const visibleToolResults = toolResults.filter((tr) => isVisibleExecutionTool(tr.name))
                if (visibleToolResults.length) {
                    this.emit('step:executed', {
                        taskId, conversationId, iteration: round + 1,
                        results: visibleToolResults.map(tr => ({
                            name: tr.name,
                            success: tr.success,
                            output: tr.output,
                            images: tr.images,
                            imageDataUrls: tr.imageDataUrls,
                            audioDataUrls: tr.audioArtifacts || tr.audioDataUrls,
                            structuredContent: tr.structuredContent,
                        }))
                    })
                    if (!hasPlanningUpdate) {
                        this.reconcilePlanningProgress(visibleToolResults)
                    }
                }

                if (this.config.saveMessages) {
                    this.saveToolResultMessages(conversationId, toolResults)
                }

                // Append tool results to context (with multimodal content for LLM vision)
                currentMessages.push({ role: 'assistant', content: fullContent || '', toolCalls: pendingToolCalls })
                for (const tr of toolResults) {
                    currentMessages.push({
                        role: 'tool' as const,
                        content: tr.imageDataUrls?.length || tr.audioDataUrls?.length
                            ? [
                                { type: 'text' as const, text: tr.output },
                                ...(tr.imageDataUrls || []).map(url => ({ type: 'image_url' as const, image_url: { url } })),
                                ...(tr.audioDataUrls || []).map(url => ({ type: 'audio_url' as const, audio_url: { url } })),
                            ]
                            : tr.output,
                        toolCallId: tr.toolCallId,
                    })
                    contextTokens = maxTokens(contextTokens, estimateTotalTokens(currentMessages))
                    this.publishContextUsage(conversationId, usage, contextTokens)
                }

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

                this.publishContextUsage(conversationId, usage, contextTokens)

                while (!pendingToolCalls?.length && this.hasOpenPlanningItems()) {
                    if (openPlanRecoveryAttempts >= OPEN_PLAN_RECOVERY_ATTEMPTS) {
                        throw new IncompletePlanningRunError()
                    }
                    openPlanRecoveryAttempts++
                    currentMessages = this.withOpenPlanRecoveryPrompt(currentMessages, fullContent)

                    const recoveryResult = await this.streamLLMRound(currentMessages, activeStreamId)
                    fullContent = recoveryResult.content
                    fullThinking += recoveryResult.thinking
                    lastRoundThinking = recoveryResult.thinking
                    collectedImages.push(...recoveryResult.images)
                    pendingToolCalls = recoveryResult.toolCalls
                    contextTokens = maxTokens(contextTokens, recoveryResult.usage?.totalTokens)
                    usage = accumulateUsage(usage, recoveryResult.usage)
                    if (this.config.streamMode === 'per-round') activeStreamId = recoveryResult.streamId
                    this.publishContextUsage(conversationId, usage, contextTokens)
                }
            }
            this.config.signal?.throwIfAborted()
            if (pendingToolCalls?.length) {
                throw new MaxToolRoundsExceededError(this.config.maxRounds)
            }
            loopCompleted = true
        } finally {
            // Guarantee stream-end is always sent even if an error escapes the loop
            this.broadcastStreamEnd(activeStreamId, {
                usage, model: this.config.model, contextTokens,
                images: collectedImages.length ? collectedImages : undefined,
            })
            if (loopCompleted) this.emit('task:completed', { taskId, conversationId })
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
        const meta = this.config.eventMeta
        this.config.broadcast(`${this._sp}-start`, {
            streamId,
            conversationId: this.config.conversationId,
            agentId: this.config.agentId,
            agentName: this.config.agentName,
            agentIconUrl: this.config.agentIconUrl,
            maCodename: meta?.maCodename,
            maAgentName: meta?.maAgentName,
            maInvocationId: meta?.maInvocationId,
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
        if (tokens == null || !this.config.isPrimaryExecutor) return
        try {
            getDb().prepare('UPDATE conversations SET last_context_tokens = ? WHERE id = ?').run(tokens, conversationId)
        } catch { /* best-effort — don't crash the execution loop */ }
    }

    /**
     * Publish context usage to both live clients and persistent conversation
     * metadata so the Context Ring updates during long tool-running turns.
     */
    private publishContextUsage(conversationId: string, usage: Usage, contextTokens: number | undefined): void {
        if (contextTokens == null) return

        if (usage) {
            this.config.broadcast(`${this._sp}-usage`, {
                conversationId,
                usage,
                model: this.config.model,
                contextWindow: this.config.contextWindow,
                contextTokens,
            })
        }
        this.maybeUpdateContextTokens(conversationId, contextTokens)
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
    private createStream(messages: ChatMessage[]): {
        stream: AsyncIterable<import('../gateway/providers/base.provider.js').StreamChunk>
        debugRoundIndex?: number
    } {
        const { gateway, tools, model, temperature, thinkingEnabled, reasoningEffort, signal, providerId } = this.config
        const request = {
            messages: AgentExecutor.trimOldImages(messages),
            model,
            tools: tools.length ? tools : undefined,
            temperature,
            thinkingEnabled,
            reasoningEffort,
            signal,
        }
        const debugRoundIndex = this.config.debugContextEnabled
            ? recordDebugModelRequest(this.config.conversationId, {
                messages: request.messages,
                tools: tools,
                model,
                temperature,
                thinkingEnabled,
                reasoningEffort,
            })
            : undefined
        return {
            stream: gateway.streamComplete(request, providerId),
            debugRoundIndex,
        }
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

        const approval = await hitlGate.requestApproval(taskId, pendingToolCalls, signal, conversationId, this.config.tools)
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
     * Returns partial state on error (via `error` field) so callers can close the
     * active stream and either retry a model-only continuation or fail the run.
     */
    private async consumeStream(
        stream: AsyncIterable<import('../gateway/providers/base.provider.js').StreamChunk>,
        streamId: string,
        debugRoundIndex?: number,
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
        const debugImages: string[] = []
        let toolCalls: ToolCall[] | undefined
        let usage: Usage
        let completed = false

        try {
            for await (const chunk of stream) {
                this.config.signal?.throwIfAborted()
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
                    debugImages.push(...chunk.images)
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
                if (chunk.done) {
                    completed = true
                    break
                }
            }
        } catch (err) {
            recordDebugModelResponse(conversationId, debugRoundIndex, {
                content, thinking, images: debugImages, toolCalls, usage,
                error: (err as Error).message,
            })
            return { content, thinking, images, toolCalls, usage, error: err as Error }
        }

        if (!completed) {
            const error = new Error('Model stream ended before a terminal completion event.')
            recordDebugModelResponse(conversationId, debugRoundIndex, {
                content, thinking, images: debugImages, toolCalls, usage,
                error: error.message,
            })
            return {
                content,
                thinking,
                images,
                toolCalls,
                usage,
                error,
            }
        }

        recordDebugModelResponse(conversationId, debugRoundIndex, {
            content, thinking, images: debugImages, toolCalls, usage,
        })
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
        let lastError: Error | undefined

        for (let attempt = 1; attempt <= MODEL_ROUND_MAX_ATTEMPTS; attempt++) {
            if (this.config.streamMode === 'per-round') {
                streamId = nanoid()
                this.broadcastStreamStart(streamId)
            } else {
                this.config.broadcast(`${this._sp}-reset`, { streamId, conversationId })
            }

            const nextStream = this.createStream(messages)
            const result = await this.consumeStream(nextStream.stream, streamId, nextStream.debugRoundIndex)

            if (!result.error) {
                if (this.config.streamMode === 'per-round') {
                    this.broadcastStreamEnd(streamId)
                }
                return {
                    content: result.content,
                    thinking: result.thinking,
                    images: result.images,
                    toolCalls: result.toolCalls,
                    usage: result.usage,
                    streamId,
                }
            }

            lastError = result.error
            const cancelled = this.config.signal?.aborted === true
            if (this.config.streamMode === 'per-round') {
                this.broadcastStreamEnd(streamId, { cancelled })
            }
            if (cancelled) throw result.error

            // Deterministic provider terminal states will not improve if the exact
            // request is repeated. Transport failures may be routed successfully on
            // one fresh model-only attempt; already-executed tools are not repeated.
            if (result.error instanceof IncompleteModelResponseError) {
                throw result.error
            }
            if (attempt < MODEL_ROUND_MAX_ATTEMPTS) {
                console.warn(
                    `[agent] Model continuation interrupted; retrying (${attempt}/${MODEL_ROUND_MAX_ATTEMPTS - 1}):`,
                    result.error.message,
                )
            }
        }

        throw lastError ?? new Error('Model continuation failed without an error.')
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

    /**
     * Execute explicitly read-only calls concurrently while preserving model
     * order around planning, writes, and tools with unknown side effects.
     */
    private async executeToolCalls(toolCalls: ToolCall[]): Promise<ToolCallResult[]> {
        const results = new Array<ToolCallResult>(toolCalls.length)

        for (const tc of toolCalls) {
            if (isVisibleExecutionTool(tc.function.name)) {
                this.config.usedToolNames?.add(tc.function.name)
            }
        }

        let readBatch: Array<{ index: number; toolCall: ToolCall }> = []
        const flushReadBatch = async () => {
            const batch = readBatch
            readBatch = []
            const batchResults = await Promise.all(batch.map(({ toolCall }) => this.executeSingleToolCall(toolCall)))
            batchResults.forEach((result, index) => { results[batch[index].index] = result })
        }

        for (const [index, toolCall] of toolCalls.entries()) {
            const tool = this.findToolForCall(toolCall.function.name)
            const canRunConcurrently = !isPlanningToolName(toolCall.function.name) && tool?.execution?.readOnly === true
            if (canRunConcurrently) {
                readBatch.push({ index, toolCall })
                continue
            }
            await flushReadBatch()
            results[index] = await this.executeSingleToolCall(toolCall)
        }
        await flushReadBatch()

        return results
    }

    private async executeSingleToolCall(tc: ToolCall): Promise<ToolCallResult> {
        const { signal } = this.config
        try {
            const args = JSON.parse(tc.function.arguments)
            const tool = this.findToolForCall(tc.function.name)

            if (!tool) {
                return { toolCallId: tc.id, name: tc.function.name, output: `Error: Unknown tool "${tc.function.name}"`, success: false }
            }

            const validation = validateToolArguments(args, tool.parameters)
            if (!validation.valid) {
                return {
                    toolCallId: tc.id,
                    name: tc.function.name,
                    output: `Invalid tool arguments: ${validation.errors.join('; ')}`,
                    success: false,
                }
            }

            const timeoutSignal = AbortSignal.timeout(tool.timeout)
            const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
            let execPromise = tool.execute(args, combined)
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
            const imageDataUrls = res?.imageDataUrls?.length
                ? res.imageDataUrls
                : this.imageArtifactsToDataUrls(images)
            const audioArtifacts = await this.materializeToolAudio(res)
            const hasReturnedMedia = Boolean(images?.length || audioArtifacts?.length || res?.audioDataUrls?.length)
            return {
                toolCallId: tc.id,
                name: tc.function.name,
                output: res?.output ?? JSON.stringify(res),
                success: res?.success !== false,
                images,
                imageDataUrls,
                audioDataUrls: res?.audioDataUrls,
                audioArtifacts,
                generatedMedia: hasReturnedMedia && toolReturnsGeneratedMedia(tool),
                structuredContent: res?.structuredContent,
                content: res?.content,
            }
        } catch (err) {
            return { toolCallId: tc.id, name: tc.function.name, output: `Error: ${(err as Error).message}`, success: false }
        }
    }

    private findToolForCall(name: string): ToolDefinition | undefined {
        const direct = this.config.tools.find(tool => tool.name === name)
        if (direct) return direct

        const originalNameMatches = this.config.tools.filter((tool) => {
            const originalName = (tool as ToolDefinition & { originalName?: string }).originalName
            return originalName === name
        })
        return originalNameMatches.length === 1 ? originalNameMatches[0] : undefined
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

    private async materializeToolAudio(res: ToolResult | undefined): Promise<string[] | undefined> {
        if (!res?.audioDataUrls?.length) return undefined
        try {
            const artifacts = await materializeAudioArtifacts(res.audioDataUrls, this.config.conversationId)
            return artifacts.map((artifact) => artifact.url)
        } catch (err) {
            console.warn('[artifacts] Failed to materialize tool audio:', err instanceof Error ? err.message : err)
            return undefined
        }
    }

    private imageArtifactsToDataUrls(images: string[] | undefined): string[] | undefined {
        if (!images?.length) return undefined
        const dataUrls: string[] = []
        for (const image of images) {
            const dataUrl = artifactFileUrlToDataUrl(image)
            if (dataUrl) dataUrls.push(dataUrl)
        }
        return dataUrls.length ? dataUrls : undefined
    }

    private addLoadedTools(tools: ToolDefinition[]): void {
        const existingNames = new Set(this.config.tools.map(tool => tool.name))

        for (const tool of tools) {
            if (existingNames.has(tool.name)) continue
            this.config.tools.push(tool)
            existingNames.add(tool.name)
        }
    }

    private reconcilePlanningProgress(results: ToolCallResult[]): void {
        const runId = this.config.planningRunId
        if (!runId || !this.config.isPrimaryExecutor) return
        const success = results.every((result) => result.success)
        const failed = results.find((result) => !result.success)
        reconcilePlanningAfterToolBatch(runId, {
            success,
            note: success ? undefined : failed?.output,
        })
    }

    private hasOpenPlanningItems(): boolean {
        const runId = this.config.planningRunId
        if (!runId || !this.config.isPrimaryExecutor) return false
        const state = getPlanningState(runId)
        if (!state || state.status !== 'running') return false
        return state.items.some((item) => item.status === 'pending' || item.status === 'in_progress')
    }

    private withOpenPlanRecoveryPrompt(messages: ChatMessage[], assistantContent: string): ChatMessage[] {
        return this.maybeTrimContext([
            ...messages,
            { role: 'assistant', content: assistantContent || '' },
            {
                role: 'user',
                content: [
                    '[Orchestrator recovery]',
                    'Your durable task list still contains pending or in-progress work.',
                    'Continue the task now. Use the available tools for any remaining work.',
                    'Before giving the final response, mark every task completed, blocked, or cancelled.',
                    'Do not merely describe what you will do next.',
                ].join('\n'),
            },
        ])
    }

    /** Save the assistant's tool-calling message (thinking + content + tool_calls) to DB. */
    private saveAssistantToolCallMessage(
        conversationId: string,
        assistantContent: string,
        thinking: string,
        toolCalls: ToolCall[],
    ): void {
        const { agentId, providerId, model } = this.config
        const meta = this.config.eventMeta
        const visibleToolCalls = toolCalls.filter((tc) => isVisibleExecutionTool(tc.function.name))
        if (!visibleToolCalls.length) return
        getDb().prepare(
            `INSERT INTO messages (
                id, conversation_id, role, content, thinking, tool_calls_json, agent_id,
                ma_codename, ma_agent_name, ma_invocation_id,
                provider, model, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            nanoid(), conversationId, 'assistant', assistantContent || '', thinking || null, JSON.stringify(visibleToolCalls), agentId || null,
            (meta?.maCodename as string) || null,
            (meta?.maAgentName as string) || null,
            (meta?.maInvocationId as string) || null,
            providerId || null, model || null, Date.now()
        )
    }

    /** Save tool result messages to DB and broadcast them to the UI. */
    private saveToolResultMessages(conversationId: string, results: ToolCallResult[]): void {
        const { broadcast, agentId, agentName, agentIconUrl } = this.config
        const meta = this.config.eventMeta
        const db = getDb()
        for (const tr of results) {
            if (!isVisibleExecutionTool(tr.name)) continue
            const toolMsgId = nanoid()
            const now = Date.now()
            db.prepare(
                `INSERT INTO messages (
                    id, conversation_id, role, content, tool_call_id, image_urls_json, audio_urls_json, generated_media,
                    structured_content_json, agent_id,
                    ma_codename, ma_agent_name, ma_invocation_id,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
                toolMsgId, conversationId, 'tool', tr.output, tr.toolCallId,
                tr.images?.length ? JSON.stringify(tr.images) : null,
                (tr.audioArtifacts || tr.audioDataUrls)?.length ? JSON.stringify(tr.audioArtifacts || tr.audioDataUrls) : null,
                tr.generatedMedia ? 1 : 0,
                tr.structuredContent === undefined ? null : JSON.stringify(tr.structuredContent),
                agentId || null,
                (meta?.maCodename as string) || null,
                (meta?.maAgentName as string) || null,
                (meta?.maInvocationId as string) || null,
                now
            )

            broadcast('chat:new-message', {
                conversationId,
                message: {
                    id: toolMsgId, conversationId, role: 'tool', content: tr.output,
                    agentId, agentName, agentIconUrl,
                    maCodename: meta?.maCodename,
                    maAgentName: meta?.maAgentName,
                    maInvocationId: meta?.maInvocationId,
                    imageDataUrls: tr.images,
                    audioDataUrls: tr.audioArtifacts || tr.audioDataUrls,
                    structuredContent: tr.structuredContent,
                    createdAt: now,
                },
            })
        }
    }
}
