import type { ProjectTaskStatus } from '@shared/types'

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - timestamp) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString()
}

export const TASK_COLUMNS: ReadonlyArray<{ status: ProjectTaskStatus; label: string; icon: string; tone: string }> = [
  { status: 'todo', label: 'To do', icon: 'lucide:circle', tone: 'text-ink-muted' },
  { status: 'in_progress', label: 'In progress', icon: 'lucide:circle-dot', tone: 'text-status-info' },
  { status: 'blocked', label: 'Blocked', icon: 'lucide:circle-alert', tone: 'text-status-warning' },
  { status: 'done', label: 'Done', icon: 'lucide:circle-check', tone: 'text-status-success' },
]
