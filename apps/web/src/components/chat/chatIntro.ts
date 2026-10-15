// ── New-chat intro timeline ───────────────────────────────────────────────────
// The empty chat assembles in one sequence: the icon materializes, the greeting
// types out, the subtitle and assigned sub-agents follow, and the pills under
// the composer arrive last. All times are milliseconds from the empty state
// appearing.

/** The greeting starts typing once the icon has mostly landed. */
const TYPE_START = 320
/** Short greetings type at a relaxed pace, long ones speed up to stay brief. */
const TYPE_TARGET = 950
const MIN_STEP = 28
const MAX_STEP = 55

/** Pills sit below the composer, in another view, so they follow a fixed beat
 *  that lands after even the longest greeting. */
export const INTRO_PILLS_MS = 1750
export const INTRO_PILL_STAGGER_MS = 80

export interface ChatIntroTimeline {
  typeStart: number
  typeStep: number
  subtitle: number
  agents: number
}

export function chatIntroTimeline(greeting: string): ChatIntroTimeline {
  const length = Math.max(1, [...greeting].length)
  const typeStep = Math.round(Math.min(MAX_STEP, Math.max(MIN_STEP, TYPE_TARGET / length)))
  const typed = TYPE_START + length * typeStep
  return {
    typeStart: TYPE_START,
    typeStep,
    subtitle: typed + 80,
    agents: typed + 280,
  }
}
