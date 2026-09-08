const INTERNAL_TOOL_PREFIXES = [
  'todo_',
  'attachment_',
  'memory_',
]

export const AUTO_MEMORY_TOOL_NAMES = [
  'memory_list_documents',
  'memory_retrieve_chunks',
  'memory_semantic_search',
  'memory_create',
  'memory_append',
] as const

export const AGENT_REQUIRED_TOOL_NAMES = [
  'schedule_create',
  'schedule_list',
  'schedule_update',
  'schedule_delete',
] as const

export type AgentRequiredToolName = (typeof AGENT_REQUIRED_TOOL_NAMES)[number]

const AGENT_REQUIRED_TOOL_NAME_SET = new Set<string>(AGENT_REQUIRED_TOOL_NAMES)

export type AutoMemoryToolName = (typeof AUTO_MEMORY_TOOL_NAMES)[number]

const INTERNAL_TOOL_NAMES = new Set([
  'expand_available_toolset',
  'memory_remove_all',
  'memory_remove_range',
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

export function isAgentRequiredBuiltInToolName(name?: string | null): name is AgentRequiredToolName {
  return Boolean(name && AGENT_REQUIRED_TOOL_NAME_SET.has(name))
}

export function agentRequiredToolStates(hasAgent: boolean): Record<AgentRequiredToolName, { met: boolean; criteria: string }> {
  return Object.fromEntries(
    AGENT_REQUIRED_TOOL_NAMES.map((name) => [name, { met: hasAgent, criteria: 'agent selected' }])
  ) as Record<AgentRequiredToolName, { met: boolean; criteria: string }>
}

export function memoryAutomaticToolStates(active: boolean, criteria = 'memory folder selected'): Record<AutoMemoryToolName, { active: boolean; criteria: string }> {
  return Object.fromEntries(
    AUTO_MEMORY_TOOL_NAMES.map((name) => [name, { active, criteria }])
  ) as Record<AutoMemoryToolName, { active: boolean; criteria: string }>
}
