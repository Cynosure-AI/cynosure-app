import { cronToHuman } from './cron-helpers'

/** A one-line description of what a tool call targets, shown next to its name. */
export interface ToolCallSummary {
  text: string
  /** Full value for the tooltip when `text` is shortened, such as a whole path. */
  title: string
}

type Args = Record<string, unknown>

function parse(args: string): Args | null {
  try {
    const parsed: unknown = JSON.parse(args)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Args : null
  } catch {
    // Arguments are still streaming or not JSON.
    return null
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ') : null
}

function plain(value: unknown): ToolCallSummary | null {
  const t = text(value)
  return t ? { text: t, title: t } : null
}

function fileName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

function file(value: unknown): ToolCallSummary | null {
  const path = text(value)
  return path ? { text: fileName(path), title: path } : null
}

function files(values: unknown): ToolCallSummary | null {
  const paths = Array.isArray(values) ? values.map(text).filter((p): p is string => Boolean(p)) : []
  if (!paths.length) return null
  const more = paths.length > 1 ? ` +${paths.length - 1}` : ''
  return { text: `${fileName(paths[0])}${more}`, title: paths.join('\n') }
}

function joined(...parts: (string | null)[]): ToolCallSummary | null {
  const t = parts.filter(Boolean).join(' · ')
  return t ? { text: t, title: t } : null
}

function scheduleTime(args: Args): string | null {
  if (typeof args.runInMinutes === 'number') return `in ${args.runInMinutes} min`
  const runAt = text(args.runAt)
  if (runAt) {
    const date = new Date(runAt)
    return Number.isNaN(date.getTime()) ? runAt : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  }
  const schedule = text(args.schedule)
  return schedule ? cronToHuman(schedule) : null
}

// Memory file references carry a stable id suffix, e.g. "user-profile#4k8z2q".
function memoryRef(value: unknown): ToolCallSummary | null {
  const ref = text(value)
  return ref ? { text: ref.replace(/#[^#]*$/, ''), title: ref } : null
}

const SUMMARIES: Record<string, (args: Args) => ToolCallSummary | null> = {
  shell_execute: (a) => plain(a.explanation) ?? plain(a.command),
  web_fetch: (a) => plain(a.url),
  file_info: (a) => file(a.path),
  file_read: (a) => file(a.path) ?? files(a.paths),
  file_write: (a) => file(a.path),
  file_edit: (a) => file(a.path),
  file_delete: (a) => file(a.path),
  file_move: (a) => {
    const source = text(a.source)
    const destination = text(a.destination)
    if (!source || !destination) return null
    return { text: `${fileName(source)} → ${fileName(destination)}`, title: `${source} → ${destination}` }
  },
  file_archive: (a) => file(a.archivePath) ?? files(a.filePaths),
  file_search: (a) => plain(a.pattern),
  file_grep: (a) => plain(a.pattern),
  directory_list: (a) => file(a.path),
  attachment_export: (a) => file(a.path),
  memory_search: (a) => plain(a.query),
  memory_create: (a) => plain(a.title),
  memory_patch: (a) => memoryRef(a.fileRef),
  memory_delete: (a) => memoryRef(a.fileRef),
  schedule_create: (a) => joined(text(a.name), scheduleTime(a)),
  schedule_update: (a) => joined(text(a.name), scheduleTime(a)),
  schedule_wait: (a) => joined(typeof a.minutes === 'number' ? `${a.minutes} min` : null, text(a.note)),
}

/** Summarizes a built-in tool call from its arguments; other tools return null. */
export function toolCallSummary(name: string | undefined, args: string | undefined): ToolCallSummary | null {
  const summarize = name ? SUMMARIES[name] : undefined
  if (!summarize || !args) return null
  const parsed = parse(args)
  return parsed ? summarize(parsed) : null
}
