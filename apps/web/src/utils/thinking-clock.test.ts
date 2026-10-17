import { describe, expect, test } from 'vitest'
import { trackThinking } from './thinking-clock'

describe('trackThinking', () => {
  test('spans from the first thought until the first answer text', () => {
    const msg = { isStreaming: true, thinking: 'Hmm', content: '' }
    expect(trackThinking(msg, 1000)).toEqual({ startedAt: 1000, endedAt: undefined })

    msg.thinking = 'Hmm, so'
    expect(trackThinking(msg, 3000)).toEqual({ startedAt: 1000, endedAt: undefined })

    msg.content = 'Answer'
    expect(trackThinking(msg, 5200)).toEqual({ startedAt: 1000, endedAt: 5200 })
    expect(trackThinking(msg, 9000)).toEqual({ startedAt: 1000, endedAt: 5200 })
  })

  test('ends when the stream stops before any answer arrives', () => {
    const msg = { isStreaming: true, thinking: 'Hmm', content: '' }
    trackThinking(msg, 1000)
    msg.isStreaming = false
    expect(trackThinking(msg, 2500)).toEqual({ startedAt: 1000, endedAt: 2500 })
  })

  test('has no timing for replies that were not seen thinking live', () => {
    expect(trackThinking({ isStreaming: false, thinking: 'Old', content: 'Done' })).toBeUndefined()
    expect(trackThinking({ isStreaming: true, thinking: 'Late', content: 'Already answering' })).toBeUndefined()
  })
})
