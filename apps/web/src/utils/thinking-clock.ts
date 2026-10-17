// Measures how long a streamed reply spent thinking: from the first reasoning
// text until the first answer text. Durations exist only for replies watched
// live; loaded history has no timing and reports undefined.
//
// Keyed by the message object, which survives the swap from its temporary
// streaming ID to the persisted one (the bubble remounts, the object does not).

type Clock = { start: number; end?: number }

const clocks = new WeakMap<object, Clock>()

interface ThinkingSnapshot {
  thinking?: string
  content?: string
  isStreaming?: boolean
}

/** Records the current phase and returns the thinking span so far, if known. */
export function trackThinking(message: ThinkingSnapshot & object, now = Date.now()): { startedAt: number; endedAt?: number } | undefined {
  let clock = clocks.get(message)
  if (!clock) {
    // Only a reply caught mid-thought has a meaningful start.
    if (!message.isStreaming || !message.thinking || message.content) return undefined
    clock = { start: now }
    clocks.set(message, clock)
  }
  if (clock.end === undefined && (message.content || !message.isStreaming)) clock.end = now
  return { startedAt: clock.start, endedAt: clock.end }
}
