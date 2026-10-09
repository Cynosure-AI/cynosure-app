import { isPlanningToolName } from './builtin/planning-tools.js'
import { TOOL_SEARCH_TOOL_NAME } from './builtin/expand-available-toolset.js'
import { isMemoryReadToolName } from './builtin/memory-tools.js'
import { isAttachmentToolName } from '../artifacts/attachment-tools.js'
import type { ToolBehaviorAnnotations } from '../gateway/providers/base.provider.js'
import { isProjectToolName } from '../projects/project-tools.js'

/**
 * Tool policy lives here so approval and UI visibility decisions use the same
 * vocabulary. Keep these predicates small: they describe behavior, not storage
 * or execution mechanics.
 */

export function isSubAgentDelegationTool(toolName: string): boolean {
  return toolName === 'spawn_subagent' || toolName === 'continue_subagent'
}

export function isInternalTool(toolName: string): boolean {
  return (
    toolName === TOOL_SEARCH_TOOL_NAME ||
    isSubAgentDelegationTool(toolName) ||
    isPlanningToolName(toolName) ||
    isMemoryReadToolName(toolName) ||
    isAttachmentToolName(toolName)
  )
}

export function isSystemAutoApprovedTool(toolName: string): boolean {
  // Project tools only change the project's own brief and task board.
  return isInternalTool(toolName) || isProjectToolName(toolName)
}

/**
 * MCP behavior hints provide the default only when the user has not saved an
 * explicit choice. A read-only declaration is accepted unless the server also
 * marks the tool destructive, which is treated conservatively as conflicting.
 */
export function isAnnotationAutoApprovedTool(annotations?: ToolBehaviorAnnotations): boolean {
  return annotations?.readOnlyHint === true && annotations.destructiveHint !== true
}

export function isVisibleExecutionTool(toolName: string): boolean {
  return Boolean(toolName)
}
