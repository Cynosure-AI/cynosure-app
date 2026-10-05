const INTERNAL_TOOL_PREFIXES = [
  'todo_',
  'attachment_',
  'memory_',
]

export const AUTO_MEMORY_TOOL_NAMES = [
  'memory_search',
  'memory_create',
  'memory_patch',
  'memory_delete',
] as const

export type AutoMemoryToolName = (typeof AUTO_MEMORY_TOOL_NAMES)[number]

const INTERNAL_TOOL_NAMES = new Set([
  'expand_available_toolset',
  'spawn_subagent',
  'continue_subagent',
])

const AUTO_MANAGED_BUILT_IN_TOOL_PREFIXES = [
  'todo_',
  'attachment_',
]

const AUTO_MANAGED_BUILT_IN_TOOL_NAMES = new Set<string>([
  ...AUTO_MEMORY_TOOL_NAMES,
  'expand_available_toolset',
  'spawn_subagent',
  'continue_subagent',
])

export function isBuiltInNamespaceId(id?: string | null): boolean {
  return id === 'builtin' || Boolean(id?.startsWith('builtin:'))
}

export function isInternalToolName(name?: string | null): boolean {
  if (!name) return false
  return INTERNAL_TOOL_NAMES.has(name) || INTERNAL_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))
}

export function isAutoManagedBuiltInToolName(name?: string | null): boolean {
  if (!name) return false
  return AUTO_MANAGED_BUILT_IN_TOOL_NAMES.has(name) || AUTO_MANAGED_BUILT_IN_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))
}

export function memoryAutomaticToolStates(active: boolean, criteria = 'memory folder selected'): Record<AutoMemoryToolName, { active: boolean; criteria: string }> {
  return Object.fromEntries(
    AUTO_MEMORY_TOOL_NAMES.map((name) => [name, { active, criteria }])
  ) as Record<AutoMemoryToolName, { active: boolean; criteria: string }>
}
