import type { ToolInfo } from '../stores/agent-runtime.store'
import { isAutoManagedBuiltInToolName, isBuiltInNamespaceId } from './internal-tools'

export interface ToolGroup {
  id: string
  label: string
  tools: ToolInfo[]
}

/**
 * Group the tools a user can pick by namespace, built-ins first. Auto-managed
 * built-ins (todo, attachments, memory) are left out because the runtime
 * attaches them on its own.
 */
export function groupSelectableTools(tools: readonly ToolInfo[]): ToolGroup[] {
  const groups = new Map<string, ToolGroup>()
  for (const tool of tools) {
    if (isBuiltInNamespaceId(tool.namespace.id) && isAutoManagedBuiltInToolName(tool.name)) continue
    const existing = groups.get(tool.namespace.id)
    if (existing) existing.tools.push(tool)
    else groups.set(tool.namespace.id, { id: tool.namespace.id, label: tool.namespace.label, tools: [tool] })
  }
  return [...groups.values()]
    .sort((a, b) => Number(isBuiltInNamespaceId(b.id)) - Number(isBuiltInNamespaceId(a.id)) || a.label.localeCompare(b.label))
}

export function toolGroupSelectionState(group: ToolGroup, selectedKeys: readonly string[]): boolean | 'mixed' {
  const selected = group.tools.filter(tool => selectedKeys.includes(tool.key)).length
  if (group.tools.length > 0 && selected === group.tools.length) return true
  return selected > 0 ? 'mixed' : false
}

/** The selection after turning every tool in `group` on or off. */
export function withToolGroup(group: ToolGroup, selectedKeys: readonly string[], enabled: boolean): string[] {
  const selected = new Set(selectedKeys)
  for (const tool of group.tools) {
    if (enabled) selected.add(tool.key)
    else selected.delete(tool.key)
  }
  return [...selected]
}
