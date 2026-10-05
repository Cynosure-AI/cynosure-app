import { isBuiltInNamespaceId } from './internal-tools'

/** Human-readable explanation for tools with a specific injection condition; empty for regular tools. */
export function toolInjectionCondition(toolName: string, namespaceId: string): string {
    if (!isBuiltInNamespaceId(namespaceId)) return 'MCP'
    if (toolName.startsWith('memory_')) return 'Memory enabled + folder available'
    if (toolName.startsWith('todo_')) return 'Thinking + execution tools'
    if (toolName.startsWith('attachment_')) return 'Tool-capable chat + files'
    if (toolName === 'expand_available_toolset') return 'Auto-tool routing enabled'
    if (toolName === 'spawn_subagent' || toolName === 'continue_subagent') return 'Sub-agent assigned'
    if (toolName === 'manage_mcp') return 'Selected explicitly'
    return ''
}
