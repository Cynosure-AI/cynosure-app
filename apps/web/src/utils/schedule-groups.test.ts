import { describe, expect, test } from 'vitest'
import { groupByNextRun, type ScheduledItem } from './schedule-groups'

// Saturday, Nov 21 2026, 10:00 local time.
const now = new Date(2026, 10, 21, 10, 0).getTime()

function job(name: string, nextRunAt: Date | null, extra: Partial<ScheduledItem> = {}): ScheduledItem {
  return { name, enabled: true, isRunning: false, nextRunAt: nextRunAt?.getTime() ?? null, ...extra }
}

function summary(items: ScheduledItem[], at = now) {
  return groupByNextRun(items, at).map(group => [group.key, group.items.map(item => item.name)])
}

describe('groupByNextRun', () => {
  test('buckets jobs by the day of their next run', () => {
    expect(summary([
      job('later', new Date(2026, 11, 10, 9)),
      job('next week', new Date(2026, 10, 25, 8)),
      job('tomorrow', new Date(2026, 10, 22, 18)),
      job('today', new Date(2026, 10, 21, 18)),
      job('overdue', new Date(2026, 10, 20, 8)),
    ])).toEqual([
      ['today', ['overdue', 'today']],
      ['tomorrow', ['tomorrow']],
      ['nextWeek', ['next week']],
      ['later', ['later']],
    ])
  })

  test('starts weeks on Monday', () => {
    const wednesday = new Date(2026, 10, 18, 10).getTime()
    expect(summary([
      job('sunday', new Date(2026, 10, 22, 9)),
      job('monday', new Date(2026, 10, 23, 9)),
    ], wednesday)).toEqual([
      ['thisWeek', ['sunday']],
      ['nextWeek', ['monday']],
    ])
  })

  test('puts running jobs first and paused or unscheduled jobs last', () => {
    expect(summary([
      job('paused', new Date(2026, 10, 21, 18), { enabled: false }),
      job('unscheduled', null),
      job('running', new Date(2026, 10, 21, 18), { isRunning: true }),
    ])).toEqual([
      ['running', ['running']],
      ['idle', ['paused', 'unscheduled']],
    ])
  })
})
