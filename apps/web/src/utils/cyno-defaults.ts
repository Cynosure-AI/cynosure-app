import type { ToolInfo } from '../stores/agent-runtime.store'
import { isBuiltInNamespaceId } from './internal-tools'

const DEFAULT_CYNO_TOOL_NAMES = new Set(['manage_mcp', 'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete'])

/** Cyno's selected tools among `tools`, or the built-in defaults (MCP management and scheduling) when it has no selection. */
export function defaultCynoToolKeys(tools: ToolInfo[], profileTools: string[] | null | undefined): string[] {
    if (profileTools) {
        const available = new Set(tools.map((tool) => tool.key))
        return profileTools.filter((key) => available.has(key))
    }
    return tools
        .filter((tool) => isBuiltInNamespaceId(tool.namespace.id) && DEFAULT_CYNO_TOOL_NAMES.has(tool.name))
        .map((tool) => tool.key)
}
