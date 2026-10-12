import type { ProjectTaskStatus } from '@shared/types'

// Hues are spread around the wheel so no two swatches read as the same color.
export const PROJECT_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#84cc16', '#f59e0b', '#ef4444', '#ec4899', '#64748b'] as const

export const DEFAULT_PROJECT_ICON = 'lucide:folder-kanban'
export const PROJECT_ICONS = [
  DEFAULT_PROJECT_ICON, 'lucide:folder', 'lucide:briefcase', 'lucide:rocket', 'lucide:target', 'lucide:lightbulb',
  'lucide:code', 'lucide:terminal', 'lucide:database', 'lucide:globe', 'lucide:book-open', 'lucide:graduation-cap',
  'lucide:flask-conical', 'lucide:microscope', 'lucide:pen-tool', 'lucide:palette', 'lucide:camera', 'lucide:music',
  'lucide:home', 'lucide:sprout', 'lucide:plane', 'lucide:map', 'lucide:heart', 'lucide:dumbbell',
  'lucide:utensils', 'lucide:shopping-cart', 'lucide:wallet', 'lucide:chart-line', 'lucide:users', 'lucide:calendar',
  'lucide:gamepad-2', 'lucide:wrench',
] as const

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
