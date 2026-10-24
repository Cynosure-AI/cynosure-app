// Picks the line of streaming reasoning worth showing in a collapsed thinking
// header. A line that has only just started ("So", "Next,") says nothing yet,
// so the previous line stays until the new one has some substance.

/** A new line takes over once it reaches this many characters. */
export const THOUGHT_MIN_CHARS = 24

export interface ThoughtLine {
  /** Line position in the reasoning text; identifies the paragraph as it grows. */
  index: number
  text: string
}

export function latestThoughtLine(thinking: string): ThoughtLine | undefined {
  const lines = thinking
    .split('\n')
    .map((line, index) => ({ index, text: line.replace(/^[#>*\-\s]+/, '').trim() }))
    .filter((line) => line.text)
  const last = lines.at(-1)
  if (!last) return undefined
  if (last.text.length >= THOUGHT_MIN_CHARS || lines.length === 1) return last
  return lines.at(-2)
}
