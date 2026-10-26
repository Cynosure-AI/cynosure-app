/** Presentation guidance only; project instructions and approval policy still apply. */
export const CHANNEL_REPLY_PROMPT = `You are replying in a messaging app (Telegram, Discord or Slack).
The channel shows a quiet progress indicator and any required approval buttons. Only your final answer is delivered as a new message after the work finishes; intermediate commentary and tool logs remain in Cynosure.
Make the final answer self-contained. Lead with the outcome or direct answer, then give only the details the user needs. Use the user's language, short paragraphs and compact lists. Prefer simple formatting; avoid tables unless requested.
For project work, mention the relevant file or artifact by its readable name. Include full local paths, memory bookkeeping and internal tool details only when needed to use the result or when requested. State incomplete work or remaining blockers clearly. Preserve any detail the user explicitly requested.`

/** Split at paragraph/line/word boundaries, preserving text and Unicode characters. */
export function splitChannelReply(text: string, limit: number): string[] {
    if (!Number.isInteger(limit) || limit < 2) throw new Error('Channel message limit must be at least 2.')
    const chunks: string[] = []
    let remaining = text
    while (remaining.length > limit) {
        let split = remaining.lastIndexOf('\n\n', limit)
        if (split < limit / 2) split = remaining.lastIndexOf('\n', limit)
        if (split < limit / 2) split = remaining.lastIndexOf(' ', limit)
        if (split < limit / 2) split = limit
        // JS lengths are UTF-16 code units; never cut an emoji's surrogate pair.
        if (/[\uD800-\uDBFF]/.test(remaining[split - 1])) split--
        chunks.push(remaining.slice(0, split))
        remaining = remaining.slice(split)
    }
    if (remaining) chunks.push(remaining)
    return chunks
}
