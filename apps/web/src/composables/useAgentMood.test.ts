import { describe, expect, test } from 'vitest'
import { countErrorStreak, deriveAgentMood, nextThinkingPose, THINKING_POSES, type AgentMood, type AgentMoodInput } from './useAgentMood'
import type { DisplayMessage } from '../stores/chat.store'

const idleChat: AgentMoodInput = { executing: false, streamingText: false, toolFailed: false, lastReply: null, errorStreak: 0, waiting: false }

function message(role: DisplayMessage['role'], extra: Partial<DisplayMessage> = {}): DisplayMessage {
  return { id: Math.random().toString(36), role, content: 'text', createdAt: 0, ...extra }
}

describe('deriveAgentMood', () => {
  test('thinks while a run works without producing text, and speaks idly once text arrives', () => {
    expect(deriveAgentMood({ ...idleChat, executing: true })).toBe('thinking')
    expect(deriveAgentMood({ ...idleChat, executing: true, streamingText: true })).toBe('idle')
  })

  test('is unsure after a failed tool until the reply starts', () => {
    expect(deriveAgentMood({ ...idleChat, executing: true, toolFailed: true })).toBe('unsure')
    expect(deriveAgentMood({ ...idleChat, executing: true, toolFailed: true, streamingText: true })).toBe('idle')
  })

  test('is sad after a failed reply and mad once failures repeat', () => {
    expect(deriveAgentMood({ ...idleChat, lastReply: { isError: true }, errorStreak: 1 })).toBe('sad')
    expect(deriveAgentMood({ ...idleChat, lastReply: { isError: true }, errorStreak: 2 })).toBe('mad')
  })

  test('dozes off when the user stopped the reply, and rests otherwise', () => {
    expect(deriveAgentMood({ ...idleChat, lastReply: { stopped: true } })).toBe('sleepy')
    expect(deriveAgentMood({ ...idleChat, lastReply: {} })).toBe('idle')
    expect(deriveAgentMood(idleChat)).toBe('idle')
  })
})

test('sleeps while a scheduled wait is pending, and wakes once the run resumes', () => {
  expect(deriveAgentMood({ ...idleChat, waiting: true, lastReply: {} })).toBe('sleepy')
  expect(deriveAgentMood({ ...idleChat, waiting: true, executing: true })).toBe('thinking')
})

test('thinking drifts between weighted poses and never repeats the one shown', () => {
  const seen = new Map<string, number>()
  let current: AgentMood = 'thinking'
  let seed = 7
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let step = 0; step < 6000; step++) {
    const next = nextThinkingPose(current, random)
    expect(next).not.toBe(current)
    seen.set(next, (seen.get(next) ?? 0) + 1)
    current = next
  }
  expect(new Set(seen.keys())).toEqual(new Set(THINKING_POSES.map(({ mood }) => mood)))
  expect(seen.get('sleepy')!).toBeLessThan(seen.get('unsure')! / 3)
  expect(seen.get('happy')!).toBeLessThan(seen.get('surprised')! / 2)
})

describe('countErrorStreak', () => {
  test('counts trailing failed replies across user turns and stops at a good one', () => {
    expect(countErrorStreak([
      message('assistant', { isError: true }),
      message('assistant'),
      message('user'),
      message('assistant', { isError: true }),
      message('user'),
      message('assistant', { isError: true }),
    ])).toBe(2)
    expect(countErrorStreak([message('user'), message('assistant')])).toBe(0)
    expect(countErrorStreak([])).toBe(0)
  })
})
