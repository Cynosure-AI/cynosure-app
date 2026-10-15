import { describe, expect, test } from 'vitest'
import { chatIntroTimeline, INTRO_PILLS_MS } from './chatIntro'

describe('chatIntroTimeline', () => {
  test('the subtitle follows the last typed character, and sub-agents follow the subtitle', () => {
    const greeting = 'Late-afternoon focus.'
    const timeline = chatIntroTimeline(greeting)
    const typed = timeline.typeStart + greeting.length * timeline.typeStep

    expect(timeline.subtitle).toBeGreaterThan(typed)
    expect(timeline.agents).toBeGreaterThan(timeline.subtitle)
  })

  test('short greetings type slower and long ones faster, within bounds', () => {
    const short = chatIntroTimeline('Hi.')
    const long = chatIntroTimeline('A much longer greeting that goes on for a while.')

    expect(short.typeStep).toBeGreaterThan(long.typeStep)
    expect(short.typeStep).toBeLessThanOrEqual(55)
    expect(long.typeStep).toBeGreaterThanOrEqual(28)
  })

  test('typical greetings finish before the pills arrive', () => {
    expect(chatIntroTimeline('Good morning. Ready to build?').agents).toBeLessThan(INTRO_PILLS_MS)
  })
})
