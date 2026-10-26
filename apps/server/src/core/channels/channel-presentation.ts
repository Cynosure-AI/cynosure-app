/** Presentation guidance only; project instructions and approval policy still apply. */
export const CHANNEL_REPLY_PROMPT = `You are replying in a messaging app (Telegram, Discord or Slack).
The channel shows a quiet progress indicator and any required approval buttons. Only your final answer is delivered as a new message after the work finishes; intermediate commentary and tool logs remain in Cynosure.
The user may send follow-up messages while you work. Treat them as corrections or additions to the current request, not as a separate task, unless they clearly ask for something unrelated.
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

export type ChannelProgressStepState = 'running' | 'done' | 'failed' | 'declined'

export interface ChannelProgressStep {
    id: string
    label: string
    state: ChannelProgressStepState
}

export interface ChannelProgress {
    elapsedMs: number
    awaitingApproval: boolean
    steps: ChannelProgressStep[]
    /** One line about the user's follow-up, e.g. that it is being taken into account. */
    note?: string
}

const PROGRESS_VISIBLE_STEPS = 5
const STEP_ICON: Record<ChannelProgressStepState, string> = { running: '›', done: '✓', failed: '✗', declined: '⊘' }

/** "45s", "2m 48s", "1h 05m". */
export function formatElapsed(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000))
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** The live status card of a running turn: one header line, recent steps, and an optional note. */
export function renderChannelProgress(progress: ChannelProgress): string {
    const header = progress.awaitingApproval
        ? '🔐 **Waiting for your approval**'
        : `⏳ **Working** · ${formatElapsed(progress.elapsedMs)}`
    const hidden = Math.max(0, progress.steps.length - PROGRESS_VISIBLE_STEPS)
    const lines = progress.steps.slice(hidden).map(step =>
        `${STEP_ICON[step.state]} ${step.label}${step.state === 'declined' ? ' — declined' : ''}`)
    if (hidden) lines.unshift(`… ${hidden} earlier ${hidden === 1 ? 'step' : 'steps'}`)
    if (progress.note) lines.push(`\n${progress.note}`)
    return [header, ...lines].join('\n')
}
