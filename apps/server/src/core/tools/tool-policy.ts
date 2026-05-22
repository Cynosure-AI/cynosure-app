import { isOrchestrationToolName } from './builtin/orchestration-tools.js'
import { TOOL_SEARCH_TOOL_NAME } from './builtin/expand-available-toolset.js'

/**
 * Tool policy lives here so approval and UI visibility decisions use the same
 * vocabulary. Keep these predicates small: they describe behavior, not storage
 * or execution mechanics.
 */

export function isSubAgentDelegationTool(toolName: string): boolean {
  return toolName.startsWith('delegate_to_')
}

export function isSystemAutoApprovedTool(toolName: string): boolean {
  return (
    toolName === TOOL_SEARCH_TOOL_NAME ||
    isSubAgentDelegationTool(toolName) ||
    isOrchestrationToolName(toolName)
  )
}

export function isVisibleExecutionTool(toolName: string): boolean {
  return !isOrchestrationToolName(toolName)
}
