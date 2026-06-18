import { isOrchestrationToolName } from './builtin/orchestration-tools.js'
import { TOOL_SEARCH_TOOL_NAME } from './builtin/expand-available-toolset.js'
import { isMemoryReadToolName, isRelationshipGraphToolName } from './builtin/memory-tools.js'
import { isAttachmentToolName } from '../artifacts/attachment-tools.js'

/**
 * Tool policy lives here so approval and UI visibility decisions use the same
 * vocabulary. Keep these predicates small: they describe behavior, not storage
 * or execution mechanics.
 */

export function isSubAgentDelegationTool(toolName: string): boolean {
  return toolName === 'spawn_subagent'
}

export function isInternalTool(toolName: string): boolean {
  return (
    toolName === TOOL_SEARCH_TOOL_NAME ||
    toolName === 'spawn_subagent' ||
    isOrchestrationToolName(toolName) ||
    isMemoryReadToolName(toolName) ||
    isRelationshipGraphToolName(toolName) ||
    isAttachmentToolName(toolName)
  )
}

export function isSystemAutoApprovedTool(toolName: string): boolean {
  return isInternalTool(toolName)
}

export function isVisibleExecutionTool(toolName: string): boolean {
  return Boolean(toolName)
}
