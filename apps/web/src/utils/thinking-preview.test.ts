import { describe, expect, test } from 'vitest'
import { latestThoughtLine } from './thinking-preview'

describe('latestThoughtLine', () => {
  test('shows the newest line once it has some substance', () => {
    expect(latestThoughtLine('First I check the schedule.\nThen I compare both calendars')).toEqual({
      index: 1,
      text: 'Then I compare both calendars',
    })
  })

  test('keeps the previous line while a new one has only just started', () => {
    expect(latestThoughtLine('First I check the schedule.\n\nSo')).toEqual({
      index: 0,
      text: 'First I check the schedule.',
    })
  })

  test('shows a short first line rather than nothing', () => {
    expect(latestThoughtLine('Okay')).toEqual({ index: 0, text: 'Okay' })
  })

  test('strips markdown markers and skips blank text', () => {
    expect(latestThoughtLine('## Comparing the two options here\n   \n')).toEqual({
      index: 0,
      text: 'Comparing the two options here',
    })
    expect(latestThoughtLine('\n  \n')).toBeUndefined()
  })
})
