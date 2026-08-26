import type { ChatMessage, ToolDefinition } from '../gateway/providers/base.provider.js'
import type { ReasoningEffort } from '@shared/types'

/**
 * Context window management strategy.
 * - 'sliding-window': Keep most recent messages (default)
 * - 'truncate-middle': Keep first + last messages, drop the middle
 * - 'compact': Summarize the conversation and continue from the summary
 * - 'none': No trimming — send everything, let the provider reject if too long
 */
export type ContextStrategy = 'sliding-window' | 'truncate-middle' | 'compact' | 'none'

export const DEFAULT_MAX_OUTPUT_TOKENS = 4_096
const MIN_OUTPUT_RESERVE = 512
const OUTPUT_RESERVE_CONTEXT_RATIO = 0.15
const MIN_SAFETY_MARGIN = 256
const SAFETY_MARGIN_CONTEXT_RATIO = 0.02
const MAX_REASONING_RESERVE = 32_768

const REASONING_RESERVE_RATIOS: Record<ReasoningEffort, number> = {
    minimal: 0.01,
    low: 0.025,
    medium: 0.05,
    high: 0.10,
    xhigh: 0.15,
    max: 0.20,
}

export interface ContextBudgetOptions {
    contextWindow: number
    messages: ChatMessage[]
    tools?: ToolDefinition[]
    requestedOutputTokens?: number
    thinkingEnabled?: boolean
    reasoningEffort?: ReasoningEffort
    safetyMargin?: number
}

export interface ContextBudget {
    contextWindow: number
    estimatedSystemTokens: number
    estimatedToolDefinitionTokens: number
    outputReserve: number
    reasoningReserve: number
    safetyMargin: number
    availableHistory: number
}

export class ContextBudgetExceededError extends Error {
    readonly budget: ContextBudget

    constructor(message: string, budget: ContextBudget) {
        super(message)
        this.name = 'ContextBudgetExceededError'
        this.budget = budget
    }
}

/**
 * Rough token estimate for a single message.
 * Uses ~4 chars per token + per-message framing overhead.
 */
export function estimateTokens(msg: ChatMessage): number {
    let textLen = 0
    if (typeof msg.content === 'string') {
        textLen = msg.content.length
    } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
            if (part.type === 'text') textLen += part.text.length
            else if (part.type === 'image_url') textLen += 4000 // 4000 chars ÷ 4 = ~1000 tokens
            else if (part.type === 'audio_url') textLen += 4000
        }
    }
    const textTokens = Math.ceil(textLen / 4)
    const toolCallTokens = msg.toolCalls
        ? Math.ceil(JSON.stringify(msg.toolCalls).length / 4)
        : 0
    return textTokens + toolCallTokens + 20
}

/** Sum estimated tokens for an array of messages. */
export function estimateTotalTokens(messages: ChatMessage[]): number {
    return messages.reduce((sum, m) => sum + estimateTokens(m), 0)
}

/** Estimate the provider-visible function declarations, including JSON Schemas. */
export function estimateToolDefinitionTokens(tools: ToolDefinition[] = []): number {
    if (!tools.length) return 0
    const providerDefinitions = tools.map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
    }))
    return Math.ceil(JSON.stringify(providerDefinitions).length / 4) + tools.length * 8
}

export function resolveOutputReserve(contextWindow: number, requestedOutputTokens?: number): number {
    if (requestedOutputTokens != null && Number.isFinite(requestedOutputTokens)) {
        return Math.max(1, Math.floor(requestedOutputTokens))
    }
    return Math.min(
        DEFAULT_MAX_OUTPUT_TOKENS,
        Math.max(MIN_OUTPUT_RESERVE, Math.floor(contextWindow * OUTPUT_RESERVE_CONTEXT_RATIO)),
    )
}

export function resolveReasoningReserve(
    contextWindow: number,
    thinkingEnabled = true,
    reasoningEffort: ReasoningEffort = 'medium',
): number {
    if (!thinkingEnabled) return 0
    return Math.min(
        MAX_REASONING_RESERVE,
        Math.floor(contextWindow * REASONING_RESERVE_RATIOS[reasoningEffort]),
    )
}

/**
 * Calculate the single source of truth for model input space.
 *
 * availableHistory = contextWindow - system - tools - output - reasoning - safety
 */
export function calculateContextBudget(options: ContextBudgetOptions): ContextBudget {
    const systemMessages = options.messages.filter((message) => message.role === 'system')
    const estimatedSystemTokens = estimateTotalTokens(systemMessages)
    const estimatedToolDefinitionTokens = estimateToolDefinitionTokens(options.tools)
    const outputReserve = resolveOutputReserve(options.contextWindow, options.requestedOutputTokens)
    const reasoningReserve = resolveReasoningReserve(
        options.contextWindow,
        options.thinkingEnabled,
        options.reasoningEffort,
    )
    const safetyMargin = options.safetyMargin ?? Math.max(
        MIN_SAFETY_MARGIN,
        Math.floor(options.contextWindow * SAFETY_MARGIN_CONTEXT_RATIO),
    )

    return {
        contextWindow: options.contextWindow,
        estimatedSystemTokens,
        estimatedToolDefinitionTokens,
        outputReserve,
        reasoningReserve,
        safetyMargin,
        availableHistory: options.contextWindow
            - estimatedSystemTokens
            - estimatedToolDefinitionTokens
            - outputReserve
            - reasoningReserve
            - safetyMargin,
    }
}

export function assertHistoryBudget(budget: ContextBudget): void {
    if (budget.availableHistory > 0) return
    const fixedReserve = budget.outputReserve + budget.reasoningReserve + budget.safetyMargin
    const inputBudget = budget.contextWindow - fixedReserve
    const detail = budget.estimatedSystemTokens > inputBudget
        ? `System messages alone require ~${budget.estimatedSystemTokens} tokens, but only ${Math.max(0, inputBudget)} input tokens remain after output, reasoning, and safety reserves.`
        : `System messages and tool definitions require ~${budget.estimatedSystemTokens + budget.estimatedToolDefinitionTokens} tokens, leaving no room for the current request.`
    throw new ContextBudgetExceededError(
        `Context budget configuration error: ${detail} Reduce the system prompt or available tools, increase the model context window, or lower the configured reserves.`,
        budget,
    )
}

export interface TrimContextOptions {
    tools?: ToolDefinition[]
    requestedOutputTokens?: number
    thinkingEnabled?: boolean
    reasoningEffort?: ReasoningEffort
    safetyMargin?: number
    strategy?: ContextStrategy
}

/**
 * Trim messages so the complete request (messages + tool declarations + output
 * and reasoning headroom) fits within the model's context window.
 */
export function trimMessagesToContextLimit(
    messages: ChatMessage[],
    contextWindow: number,
    options: TrimContextOptions = {},
): ChatMessage[] {
    let strategy = options.strategy ?? 'sliding-window'
    if (strategy === 'none') return messages
    // 'compact' is handled before the executor starts. Within a multi-round
    // execution, fall back to sliding-window as tool results grow.
    if (strategy === 'compact') strategy = 'sliding-window'

    const budget = calculateContextBudget({
        contextWindow,
        messages,
        tools: options.tools,
        requestedOutputTokens: options.requestedOutputTokens,
        thinkingEnabled: options.thinkingEnabled,
        reasoningEffort: options.reasoningEffort,
        safetyMargin: options.safetyMargin,
    })
    assertHistoryBudget(budget)

    const systemMsgs = messages.filter((message) => message.role === 'system')
    const nonSystemMsgs = messages.filter((message) => message.role !== 'system')
    const totalHistoryTokens = estimateTotalTokens(nonSystemMsgs)
    if (totalHistoryTokens <= budget.availableHistory) return messages

    const lastUserMsg = [...nonSystemMsgs].reverse().find((message) => message.role === 'user')
    if (lastUserMsg && estimateTokens(lastUserMsg) > budget.availableHistory) {
        throw new ContextBudgetExceededError(
            `Context budget configuration error: the current user request requires ~${estimateTokens(lastUserMsg)} tokens, but only ${budget.availableHistory} history tokens are available after system messages, tools, output, reasoning, and safety reserves.`,
            budget,
        )
    }

    let keptMsgs: ChatMessage[]
    let trimmedCount: number
    let headLength = 0

    if (strategy === 'truncate-middle') {
        const result = truncateMiddle(nonSystemMsgs, budget.availableHistory)
        keptMsgs = result.kept
        trimmedCount = result.trimmed
        headLength = result.headLength
    } else {
        ({ kept: keptMsgs, trimmed: trimmedCount } = slidingWindow(nonSystemMsgs, budget.availableHistory))
    }

    if (lastUserMsg && !keptMsgs.includes(lastUserMsg)) {
        throw new ContextBudgetExceededError(
            'Context budget configuration error: trimming would remove the current user request. The model call was stopped instead of sending an amnesic request.',
            budget,
        )
    }
    const keptHistoryTokens = estimateTotalTokens(keptMsgs)
    if (keptHistoryTokens > budget.availableHistory) {
        throw new ContextBudgetExceededError(
            `Context budget configuration error: the latest indivisible request/tool-result group requires ~${keptHistoryTokens} tokens, but only ${budget.availableHistory} history tokens are available.`,
            budget,
        )
    }
    if (trimmedCount === 0) return messages

    const trimmedTokens = totalHistoryTokens - keptHistoryTokens

    if (strategy === 'truncate-middle' && headLength < keptMsgs.length) {
        const tailMsg = keptMsgs[headLength]
        const note = `[Note: ${trimmedCount} earlier messages were omitted from the middle of the conversation to fit the context window.]\n\n`
        if (typeof tailMsg.content === 'string') {
            keptMsgs[headLength] = { ...tailMsg, content: note + tailMsg.content }
        } else if (Array.isArray(tailMsg.content)) {
            keptMsgs[headLength] = { ...tailMsg, content: [{ type: 'text' as const, text: note }, ...tailMsg.content] }
        }
    }

    const trimNote = `\n\n[Earlier conversation history (${trimmedCount} messages, ~${trimmedTokens} tokens) was trimmed to fit the context window. Continue from the remaining context.]`
    const mergedSystemMsgs = systemMsgs.length
        ? systemMsgs.map((message, index) =>
            index === systemMsgs.length - 1
                ? { ...message, content: (typeof message.content === 'string' ? message.content : '') + trimNote }
                : message
        )
        : [{ role: 'system' as const, content: trimNote.trimStart() }]

    return [...mergedSystemMsgs, ...keptMsgs]
}

function slidingWindow(
    msgs: ChatMessage[],
    budget: number,
): { kept: ChatMessage[]; trimmed: number } {
    let running = 0
    let cutIndex = 0
    for (let i = msgs.length - 1; i >= 0; i--) {
        const cost = estimateTokens(msgs[i])
        if (running + cost > budget) {
            cutIndex = i + 1
            break
        }
        running += cost
    }

    while (cutIndex < msgs.length && msgs[cutIndex].role === 'tool') cutIndex++
    while (cutIndex < msgs.length && msgs[cutIndex].role !== 'user') cutIndex++

    if (cutIndex >= msgs.length && msgs.length > 0) {
        cutIndex = findLastUserIndex(msgs)
    }

    return { kept: msgs.slice(cutIndex), trimmed: cutIndex }
}

function truncateMiddle(
    msgs: ChatMessage[],
    budget: number,
): { kept: ChatMessage[]; trimmed: number; headLength: number } {
    const headBudget = Math.floor(budget * 0.4)
    const tailBudget = budget - headBudget

    let headTokens = 0
    let headEnd = 0
    for (let i = 0; i < msgs.length; i++) {
        const cost = estimateTokens(msgs[i])
        if (headTokens + cost > headBudget) break
        headTokens += cost
        headEnd = i + 1
    }

    while (headEnd > 0 && msgs[headEnd - 1].role === 'tool') headEnd--
    if (headEnd > 0 && headEnd < msgs.length && msgs[headEnd - 1].toolCalls?.length) headEnd--

    let tailTokens = 0
    let tailStart = msgs.length
    for (let i = msgs.length - 1; i >= headEnd; i--) {
        const cost = estimateTokens(msgs[i])
        if (tailTokens + cost > tailBudget) break
        tailTokens += cost
        tailStart = i
    }

    while (tailStart < msgs.length && msgs[tailStart].role === 'tool') tailStart++
    while (tailStart < msgs.length && msgs[tailStart].role !== 'user') tailStart++

    if (tailStart >= msgs.length && msgs.length > headEnd) {
        tailStart = findLastUserIndex(msgs, headEnd)
    }

    const head = msgs.slice(0, headEnd)
    const tail = msgs.slice(tailStart)
    return {
        kept: [...head, ...tail],
        trimmed: msgs.length - head.length - tail.length,
        headLength: head.length,
    }
}

function findLastUserIndex(msgs: ChatMessage[], minIndex = 0): number {
    for (let i = msgs.length - 1; i >= minIndex; i--) {
        if (msgs[i].role === 'user') return i
    }
    return minIndex
}
