import { describe, expect, test } from 'vitest'
import { dayPartOf, getGreeting, occasionGreetings, seasonOf } from './greetings'

// Local-time dates; months are zero-based as in the Date constructor.
const at = (year: number, month: number, day: number, hour: number) => new Date(year, month, day, hour)
const always = (value: number) => () => value

describe('getGreeting', () => {
  test('prefers date-specific occasions when the occasion layer is chosen', () => {
    expect(getGreeting(at(2026, 0, 1, 10), always(0), false)).toBe('Happy New Year!')
    expect(getGreeting(at(2026, 9, 31, 20), always(0), false)).toBe('Happy Halloween!')
  })

  test('uses the weekday layer for the current day part', () => {
    // 2026-10-05 is a Monday; morning-specific lines come first.
    expect(getGreeting(at(2026, 9, 5, 9), always(0), false)).toBe('Fresh week. Where do we start?')
    // 2026-10-09 is a Friday afternoon.
    expect(getGreeting(at(2026, 9, 9, 15), always(0), false)).toBe('Friday afternoon. Ship it?')
  })

  test('falls through to seasonal and then hourly greetings', () => {
    // 2026-10-08 (Thursday): skip weekday (0.5 ≥ 0.3), take season (0.1 < 0.2).
    const seasonal = [0.5, 0.1, 0]
    expect(getGreeting(at(2026, 9, 8, 9), () => seasonal.shift()!, false)).toBe('Foggy autumn morning?')
    expect(getGreeting(at(2026, 9, 8, 0), always(0.99), false)).toBe('One more thing before sleep?')
  })

  test('skips generic weekday and seasonal lines at night', () => {
    // Thursday 02:00 has no night-specific weekday or season lines, so random 0 lands on hourly.
    expect(getGreeting(at(2026, 9, 8, 2), always(0), false)).toBe('Night shift active.')
    // Friday 23:00 has an explicit night line.
    expect(getGreeting(at(2026, 9, 9, 23), always(0), false)).toBe('Friday night experiments?')
  })
})

describe('occasionGreetings', () => {
  test('is empty on an ordinary day', () => {
    expect(occasionGreetings(at(2026, 9, 8, 12), false)).toEqual([])
  })

  test('covers month boundaries with the month name', () => {
    expect(occasionGreetings(at(2026, 10, 1, 12), false)).toContain('Hello, November.')
    expect(occasionGreetings(at(2026, 1, 28, 12), false)).toContain('Last day of February.')
    expect(occasionGreetings(at(2028, 1, 28, 12), false)).not.toContain('Last day of February.')
    expect(occasionGreetings(at(2028, 1, 29, 12), false)).toEqual(['Leap day. A bonus day.'])
  })

  test('recognizes Programmer’s Day in common and leap years', () => {
    expect(occasionGreetings(at(2026, 8, 13, 12), false)).toContain('Happy Programmer’s Day!')
    expect(occasionGreetings(at(2028, 8, 12, 12), false)).toContain('Happy Programmer’s Day!')
  })

  test('recognizes Friday the 13th', () => {
    expect(occasionGreetings(at(2026, 10, 13, 12), false)).toContain('Friday the 13th. Commit carefully.')
    expect(occasionGreetings(at(2026, 9, 13, 12), false)).toEqual([])
  })

  test('flips the solstice by hemisphere', () => {
    expect(occasionGreetings(at(2026, 5, 21, 12), false)).toContain('Longest day of the year.')
    expect(occasionGreetings(at(2026, 5, 21, 12), true)).toContain('Shortest day of the year.')
    expect(occasionGreetings(at(2026, 11, 21, 12), false)).toContain('Shortest day of the year.')
  })
})

describe('seasonOf', () => {
  test('maps months to meteorological seasons per hemisphere', () => {
    expect([11, 0, 2, 5, 9].map((month) => seasonOf(month, false))).toEqual(['winter', 'winter', 'spring', 'summer', 'autumn'])
    expect([11, 0, 2, 5, 9].map((month) => seasonOf(month, true))).toEqual(['summer', 'summer', 'autumn', 'winter', 'spring'])
  })
})

describe('dayPartOf', () => {
  test('splits the day into night, morning, afternoon and evening', () => {
    expect([0, 4, 5, 11, 12, 16, 17, 21, 22, 23].map(dayPartOf)).toEqual([
      'night', 'night', 'morning', 'morning', 'afternoon', 'afternoon', 'evening', 'evening', 'night', 'night',
    ])
  })
})
