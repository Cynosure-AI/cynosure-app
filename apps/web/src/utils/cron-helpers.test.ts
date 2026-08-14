import { describe, expect, test } from 'vitest'
import { buildCronExpr, cronToHuman, parseCronExpr, type CronParts } from './cron-helpers'

const defaults: CronParts = {
  frequency: 'daily',
  everyMinutes: 30,
  atMinute: 5,
  atHour: 9,
  weekday: 1,
  monthDay: 1,
  customExpr: '',
}

describe('cron schedule helpers', () => {
  test.each([
    ['*/15 * * * *', 'minutes', { everyMinutes: 15 }],
    ['5 * * * *', 'hourly', { atMinute: 5 }],
    ['30 9 * * *', 'daily', { atMinute: 30, atHour: 9 }],
    ['0 8 * * 1', 'weekly', { atMinute: 0, atHour: 8, weekday: 1 }],
    ['45 17 12 * *', 'monthly', { atMinute: 45, atHour: 17, monthDay: 12 }],
  ])('parses %s as %s', (expression, frequency, expected) => {
    expect(parseCronExpr(expression)).toMatchObject({ frequency, ...expected })
  })

  test('preserves unsupported expressions as custom input', () => {
    expect(parseCronExpr('0 9 * JAN MON')).toMatchObject({
      frequency: 'custom',
      customExpr: '0 9 * JAN MON',
    })
    expect(parseCronExpr('invalid')).toMatchObject({ frequency: 'custom', customExpr: 'invalid' })
  })

  test.each([
    [{ ...defaults, frequency: 'minutes', everyMinutes: 10 }, '*/10 * * * *', 'Every 10 min'],
    [{ ...defaults, frequency: 'hourly' }, '5 * * * *', 'Hourly at :05'],
    [{ ...defaults, frequency: 'daily' }, '5 9 * * *', 'Daily at 09:05'],
    [{ ...defaults, frequency: 'weekly', weekday: 1 }, '5 9 * * 1', 'Mondays at 09:05'],
    [{ ...defaults, frequency: 'monthly', monthDay: 12 }, '5 9 12 * *', 'Monthly on day 12 at 09:05'],
    [{ ...defaults, frequency: 'custom', customExpr: '1 2 3 4 5' }, '1 2 3 4 5', '1 2 3 4 5'],
  ] as const)('builds and describes a %s schedule', (parts, expression, human) => {
    expect(buildCronExpr(parts)).toBe(expression)
    expect(cronToHuman(parts)).toBe(human)
  })
})
