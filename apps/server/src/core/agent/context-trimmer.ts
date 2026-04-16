import type { ChatMessage } from '../gateway/providers/base.provider.js'

/**
 * Fraction of context window to target when trimming.
 * 75% leaves 25% for thinking tokens + completion output.
 */
const CONTEXT_THRESHOLD = 0.75

/**
 * Rough token estimate for a single message.
 * Uses ~3 chars per token (conservative) + per-message framing overhead.
 */
export function estimateTokens(msg: ChatMessage): number {
    let textLen = 0
    if (typeof msg.content === 'string') {
        textLen = msg.content.length
    } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
            if (part.type === 'text') textLen += part.text.length
            else if (part.type === 'image_url') textLen += 4000 // ~1000 tokens
        }
    }
    const textTokens = Math.ceil(textLen / 3)
    const toolCallTokens = msg.toolCalls
        ? Math.ceil(JSON.stringify(msg.toolCalls).length / 3)
        : 0
    return textTokens + toolCallTokens + 15
}

/** Sum estimated tokens for an array of messages. */
export function estimateTotalTokens(messages: ChatMessage[]): number {
    return messages.reduce((sum, m) => sum + estimateTokens(m), 0)
}

/**
 * Trim old messages so the prompt fits within the model's context window.
 *
 * Preserves:
 *  - All system messages
 *  - The most recent messages that fit within the budget
 *  - Tool call/result groups (never split)
 *
 * Inserts a system note when history is trimmed.
 */
export function trimMessagesToContextLimit(
    messages: ChatMessage[],
    contextWindow: number,
    threshold = CONTEXT_THRESHOLD,
): ChatMessage[] {
    const maxTokens = Math.floor(contextWindow * threshold)

    const totalEstimate = messages.reduce((sum, m) => sum + estimateTokens(m), 0)
    if (totalEstimate <= maxTokens) return messages

    // Separate system messages (always preserved)
    const systemMsgs: ChatMessage[] = []
    const nonSystemMsgs: ChatMessage[] = []
    for (const msg of messages) {
        if (msg.role === 'system') systemMsgs.push(msg)
        else nonSystemMsgs.push(msg)
    }

    const systemTokens = systemMsgs.reduce((sum, m) => sum + estimateTokens(m), 0)
    const budget = maxTokens - systemTokens
    if (budget <= 0) return [...systemMsgs]

    // Walk backward from most recent, keeping until budget exceeded
    let running = 0
    let cutIndex = 0
    for (let i = nonSystemMsgs.length - 1; i >= 0; i--) {
        running += estimateTokens(nonSystemMsgs[i])
        if (running > budget) {
            cutIndex = i + 1
            break
        }
    }

    // Don't split tool call groups
    while (cutIndex < nonSystemMsgs.length && nonSystemMsgs[cutIndex].role === 'tool') {
        cutIndex++
    }

    if (cutIndex === 0) return messages

    const keptMsgs = nonSystemMsgs.slice(cutIndex)
    const trimmedCount = cutIndex

    const trimNote: ChatMessage = {
        role: 'system',
        content: `[Earlier conversation history (${trimmedCount} messages) was trimmed to fit the context window. Continue from the remaining context.]`,
    }

    return [...systemMsgs, trimNote, ...keptMsgs]
}
