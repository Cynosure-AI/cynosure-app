import type { PlanningRunStatus, PlanningTaskStatus } from '../api/types'

export const PLANNING_ITEM_STATUS: Record<PlanningTaskStatus, { icon: string; cls: string }> = {
  pending: { icon: 'lucide:circle', cls: 'text-ink-muted' },
  in_progress: { icon: 'svg-spinners:ring-resize', cls: 'text-accent-fg' },
  completed: { icon: 'lucide:check-circle-2', cls: 'text-status-success' },
  blocked: { icon: 'lucide:octagon-alert', cls: 'text-status-warning' },
  cancelled: { icon: 'lucide:circle-x', cls: 'text-ink-muted' },
}

export const PLANNING_RUN_STATUS: Record<PlanningRunStatus, { label: string; cls: string }> = {
  running: { label: 'In progress', cls: 'text-status-info' },
  completed: { label: 'Completed', cls: 'text-status-success' },
  cancelled: { label: 'Cancelled', cls: 'text-ink-muted' },
  error: { label: 'Stopped', cls: 'text-status-warning' },
}
