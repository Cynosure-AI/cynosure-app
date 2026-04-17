import type { ChatMessage } from '../gateway/providers/base.provider.js'

/**
 * Context window management strategy.
 * - 'sliding-window': Keep most recent messages (default)
 * - 'truncate-middle': Keep first + last messages, drop the middle
 * - 'none': No trimming — send everything, let the provider reject if too long
 */
export type ContextStrategy = 'sliding-window' | 'truncate-middle' | 'none'

/**
 * Fraction of context window to target when trimming.
 * 75% leaves 25% for thinking tokens + completion output.
 */
const CONTEXT_THRESHOLD = 0.75

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

/**
 * Trim messages so the prompt fits within the model's context window.
 *
 * Preserves:
 *  - All system messages
 *  - Tool call/result groups (never split)
 *
 * Inserts a system note when history is trimmed.
 *
 * @param strategy - 'sliding-window' (default), 'truncate-middle', or 'none'
 */
export function trimMessagesToContextLimit(
    messages: ChatMessage[],
    contextWindow: number,
    threshold = CONTEXT_THRESHOLD,
    strategy: ContextStrategy = 'sliding-window',
): ChatMessage[] {
    if (strategy === 'none') return messages

    const maxTokens = Math.floor(contextWindow * threshold)

    const totalEstimate = estimateTotalTokens(messages)
    if (totalEstimate <= maxTokens) return messages

    // Separate system messages (always preserved)
    const systemMsgs: ChatMessage[] = []
    const nonSystemMsgs: ChatMessage[] = []
    for (const msg of messages) {
        if (msg.role === 'system') systemMsgs.push(msg)
        else nonSystemMsgs.push(msg)
    }

    const systemTokens = estimateTotalTokens(systemMsgs)
    const budget = maxTokens - systemTokens
    if (budget <= 0) return [...systemMsgs]

    let keptMsgs: ChatMessage[]
    let trimmedCount: number

    if (strategy === 'truncate-middle') {
        ({ kept: keptMsgs, trimmed: trimmedCount } = truncateMiddle(nonSystemMsgs, budget))
    } else {
        ({ kept: keptMsgs, trimmed: trimmedCount } = slidingWindow(nonSystemMsgs, budget))
    }

    if (trimmedCount === 0) return messages

    const trimmedTokens = totalEstimate - systemTokens - estimateTotalTokens(keptMsgs)

    // Append the trim note to the last system message so providers that only
    // read the first system message (Anthropic, OpenAI, Gemini…) still see it.
    const trimNote = `\n\n[Earlier conversation history (${trimmedCount} messages, ~${trimmedTokens} tokens) was trimmed to fit the context window. Continue from the remaining context.]`
    const mergedSystemMsgs = systemMsgs.length
        ? systemMsgs.map((m, i) =>
            i === systemMsgs.length - 1
                ? { ...m, content: (typeof m.content === 'string' ? m.content : '') + trimNote }
                : m
        )
        : [{ role: 'system' as const, content: trimNote.trimStart() }]

    return [...mergedSystemMsgs, ...keptMsgs]
}

/**
 * Sliding window: keep the most recent messages that fit the budget.
 */
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

    // Don't keep orphaned tool-result messages whose parent assistant was trimmed.
    while (cutIndex < msgs.length && msgs[cutIndex].role === 'tool') {
        cutIndex++
    }

    // Many providers require the first non-system message to be a user message.
    while (cutIndex < msgs.length && msgs[cutIndex].role !== 'user') {
        cutIndex++
    }

    return { kept: msgs.slice(cutIndex), trimmed: cutIndex }
}

/**
 * Truncate middle: keep the first and last messages, drop from the middle.
 * This preserves the initial conversation context and the most recent exchanges.
 */
function truncateMiddle(
    msgs: ChatMessage[],
    budget: number,
): { kept: ChatMessage[]; trimmed: number } {
    // Allocate budget: ~40% to head, ~60% to tail (recent context is more valuable)
    const headBudget = Math.floor(budget * 0.4)
    const tailBudget = budget - headBudget

    // Build head (from start)
    let headTokens = 0
    let headEnd = 0
    for (let i = 0; i < msgs.length; i++) {
        const cost = estimateTokens(msgs[i])
        if (headTokens + cost > headBudget) break
        headTokens += cost
        headEnd = i + 1
    }

    // Don't split tool groups at the head boundary:
    // if headEnd lands on a tool message, back up to before the tool group
    while (headEnd > 0 && msgs[headEnd - 1].role === 'tool') {
        headEnd--
    }
    // Also back up past an assistant with toolCalls that lost its tool results
    if (headEnd > 0 && headEnd < msgs.length && msgs[headEnd - 1].toolCalls?.length) {
        headEnd--
    }

    // Build tail (from end)
    let tailTokens = 0
    let tailStart = msgs.length
    for (let i = msgs.length - 1; i >= headEnd; i--) {
        const cost = estimateTokens(msgs[i])
        if (tailTokens + cost > tailBudget) break
        tailTokens += cost
        tailStart = i
    }

    // Don't keep orphaned tool-result messages at the tail start
    while (tailStart < msgs.length && msgs[tailStart].role === 'tool') {
        tailStart++
    }

    // Ensure first non-system message in tail is a user message
    while (tailStart < msgs.length && msgs[tailStart].role !== 'user') {
        tailStart++
    }

    const head = msgs.slice(0, headEnd)
    const tail = msgs.slice(tailStart)
    const trimmed = msgs.length - head.length - tail.length

    return { kept: [...head, ...tail], trimmed }
}
