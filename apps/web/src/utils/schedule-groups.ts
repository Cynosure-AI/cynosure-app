/** Buckets a scheduled job can fall into, in display order. */
export type ScheduleGroupKey = 'running' | 'today' | 'tomorrow' | 'thisWeek' | 'nextWeek' | 'later' | 'idle'

export interface ScheduledItem {
  name: string
  enabled: boolean
  isRunning: boolean
  nextRunAt: number | null
}

export interface ScheduleGroup<T> {
  key: ScheduleGroupKey
  label: string
  /** First day the group covers (local midnight), when it covers a date range. */
  start: number | null
  /** Day after the last day the group covers, when the range is closed. */
  end: number | null
  items: T[]
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

/**
 * Groups jobs by when they run next, relative to `now` in local time.
 * Weeks start on Monday. Overdue jobs count as today. Paused jobs and jobs
 * without a next run go to the last group. Empty groups are left out.
 */
export function groupByNextRun<T extends ScheduledItem>(items: T[], now: number): ScheduleGroup<T>[] {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const tomorrow = addDays(today, 1)
  const dayAfterTomorrow = addDays(today, 2)
  const weekStart = addDays(today, -((today.getDay() + 6) % 7))
  const nextWeek = addDays(weekStart, 7)
  const weekAfterNext = addDays(weekStart, 14)

  const groups: ScheduleGroup<T>[] = [
    { key: 'running', label: 'Running now', start: null, end: null, items: [] },
    { key: 'today', label: 'Today', start: today.getTime(), end: tomorrow.getTime(), items: [] },
    { key: 'tomorrow', label: 'Tomorrow', start: tomorrow.getTime(), end: dayAfterTomorrow.getTime(), items: [] },
    { key: 'thisWeek', label: 'Later this week', start: dayAfterTomorrow.getTime(), end: nextWeek.getTime(), items: [] },
    { key: 'nextWeek', label: 'Next week', start: nextWeek.getTime(), end: weekAfterNext.getTime(), items: [] },
    { key: 'later', label: 'Later', start: weekAfterNext.getTime(), end: null, items: [] },
    { key: 'idle', label: 'No upcoming run', start: null, end: null, items: [] },
  ]
  const byKey = new Map(groups.map(group => [group.key, group]))

  for (const item of items) {
    byKey.get(groupKeyFor(item, groups))!.items.push(item)
  }

  const byName = (a: T, b: T) => a.name.localeCompare(b.name)
  for (const group of groups) {
    if (group.key === 'running' || group.key === 'idle') group.items.sort(byName)
    else group.items.sort((a, b) => a.nextRunAt! - b.nextRunAt! || byName(a, b))
  }
  return groups.filter(group => group.items.length > 0)
}

function groupKeyFor(item: ScheduledItem, groups: ScheduleGroup<unknown>[]): ScheduleGroupKey {
  if (item.isRunning) return 'running'
  if (!item.enabled || item.nextRunAt == null) return 'idle'
  const runAt = item.nextRunAt
  // Ranges are ordered, so the first open end above the run time wins; overdue runs land in today.
  const dated = groups.find(group => group.start != null && (group.end == null || runAt < group.end))
  return dated?.key ?? 'later'
}
