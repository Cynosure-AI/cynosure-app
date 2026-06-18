const INTERNAL_TOOL_PREFIXES = [
  'orchestrator_',
  'attachment_',
  'memory_',
  'entity_graph_',
]

const INTERNAL_TOOL_NAMES = new Set([
  'expand_available_toolset',
  'forget_memory',
  'spawn_subagent',
])

export function isInternalToolName(name?: string | null): boolean {
  if (!name) return false
  return INTERNAL_TOOL_NAMES.has(name) || INTERNAL_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))
}
