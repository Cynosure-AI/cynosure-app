const INTERNAL_TOOL_PREFIXES = [
  'todo_',
  'attachment_',
  'memory_',
]

const INTERNAL_TOOL_NAMES = new Set([
  'expand_available_toolset',
  'memory_remove',
  'spawn_subagent',
])

const AUTO_MANAGED_BUILT_IN_TOOL_PREFIXES = [
  'todo_',
  'attachment_',
  'memory_',
]

const AUTO_MANAGED_BUILT_IN_TOOL_NAMES = new Set([
  'expand_available_toolset',
  'memory_remove',
  'spawn_subagent',
])

export function isInternalToolName(name?: string | null): boolean {
  if (!name) return false
  return INTERNAL_TOOL_NAMES.has(name) || INTERNAL_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))
}

export function isAutoManagedBuiltInToolName(name?: string | null): boolean {
  if (!name) return false
  return AUTO_MANAGED_BUILT_IN_TOOL_NAMES.has(name) || AUTO_MANAGED_BUILT_IN_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))
}
