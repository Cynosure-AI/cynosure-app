import type { ToolBehaviorAnnotations, ToolCall, ToolDefinition } from '../gateway/providers/base.provider.js'
import { getEventBus } from '../telemetry/event-bus.js'
import { getDb } from '../../db/database.js'
import { isAnnotationAutoApprovedTool, isSystemAutoApprovedTool } from '../tools/tool-policy.js'
import { fileToolNeedsFolderApproval, runInFileAccessScope } from '../tools/builtin/file-access-policy.js'

export interface ApprovalResult {
  approved: boolean
  denied?: boolean
  reason?: string
}

export class HITLGate {
  private eventBus = getEventBus()
  private pendingByConversation = new Map<string, string>() // taskId → conversationId
  private sessionApprovals = new Map<string, Set<string>>() // conversationId → Set<toolName>
  private readonly allToolsApproval = '*'

  /** Returns the set of conversationIds that currently have a pending HITL request. */
  getPendingConversationIds(): Set<string> {
    return new Set(this.pendingByConversation.values())
  }

  /** Track a permission prompt that uses the HITL transport outside the normal tool approval gate. */
  trackExternalRequest(taskId: string, conversationId: string): void {
    this.pendingByConversation.set(taskId, conversationId)
  }

  clearExternalRequest(taskId: string): void {
    this.pendingByConversation.delete(taskId)
  }

  /** Clear pending HITL bookkeeping for a conversation and return affected task IDs. */
  clearPendingForConversation(conversationId: string): string[] {
    const taskIds: string[] = []
    for (const [taskId, pendingConversationId] of this.pendingByConversation.entries()) {
      if (pendingConversationId !== conversationId) continue
      taskIds.push(taskId)
      this.pendingByConversation.delete(taskId)
    }
    return taskIds
  }

  /** Returns the effective approval state: system, explicit user choice, then annotation default. */
  isAutoApproved(toolName: string, annotations?: ToolBehaviorAnnotations): boolean {
    if (isSystemAutoApprovedTool(toolName)) return true
    const db = getDb()
    const row = db.prepare('SELECT auto_approve FROM tool_approvals WHERE tool_name = ?').get(toolName) as { auto_approve: number } | undefined
    if (row) return row.auto_approve === 1
    return isAnnotationAutoApprovedTool(annotations)
  }

  /** Set auto-approve for a specific tool. */
  setAutoApprove(toolName: string, autoApprove: boolean): void {
    const db = getDb()
    db.prepare(
      'INSERT INTO tool_approvals (tool_name, auto_approve) VALUES (?, ?) ON CONFLICT(tool_name) DO UPDATE SET auto_approve = ?'
    ).run(toolName, autoApprove ? 1 : 0, autoApprove ? 1 : 0)
  }

  /** Get the full map of tool approval states. */
  getAllApprovals(): Record<string, boolean> {
    const db = getDb()
    const rows = db.prepare('SELECT tool_name, auto_approve FROM tool_approvals').all() as { tool_name: string; auto_approve: number }[]
    const result: Record<string, boolean> = {}
    for (const row of rows) {
      result[row.tool_name] = row.auto_approve === 1
    }
    return result
  }

  /** Bulk-set auto-approve for multiple tools at once. */
  setAutoApproveBulk(approvals: Record<string, boolean>): void {
    const db = getDb()
    const stmt = db.prepare(
      'INSERT INTO tool_approvals (tool_name, auto_approve) VALUES (?, ?) ON CONFLICT(tool_name) DO UPDATE SET auto_approve = ?'
    )
    const tx = db.transaction(() => {
      for (const [name, autoApprove] of Object.entries(approvals)) {
        stmt.run(name, autoApprove ? 1 : 0, autoApprove ? 1 : 0)
      }
    })
    tx()
  }

  /** Remove explicit choices so tools fall back to system and annotation policy. */
  resetAutoApproveBulk(toolNames: string[]): void {
    if (toolNames.length === 0) return

    const db = getDb()
    const stmt = db.prepare('DELETE FROM tool_approvals WHERE tool_name = ?')
    const tx = db.transaction(() => {
      for (const name of new Set(toolNames)) stmt.run(name)
    })
    tx()
  }

  async requestApproval(
    taskId: string,
    toolCalls: ToolCall[],
    signal?: AbortSignal,
    conversationId?: string,
    tools: ToolDefinition[] = []
  ): Promise<ApprovalResult> {
    // A folder card authorizes that file tool invocation. All other calls use
    // the normal tool approval policy.
    const sessionSet = conversationId ? this.getSessionApprovals(conversationId) : undefined
    const toolsByName = new Map(tools.map((tool) => [tool.name, tool]))
    const annotationsByName = new Map(tools.map((tool) => [tool.name, tool.annotations]))
    const specificallyApprovedCalls = new Set<string>()
    for (const tc of toolCalls) {
      const tool = toolsByName.get(tc.function.name) as (ToolDefinition & { namespaceId?: string; originalName?: string }) | undefined
      if (tool?.namespaceId !== 'builtin:files') continue
      try {
        const args = JSON.parse(tc.function.arguments) as Record<string, unknown>
        if (await runInFileAccessScope(conversationId, () => fileToolNeedsFolderApproval(tool.originalName || tool.name, args))) {
          specificallyApprovedCalls.add(tc.id)
        }
      } catch { /* Invalid arguments are handled by the executor. */ }
    }
    const needsApproval = toolCalls.filter(
      (tc) => !specificallyApprovedCalls.has(tc.id)
        && !isSystemAutoApprovedTool(tc.function.name)
        && !this.isAutoApproved(tc.function.name, annotationsByName.get(tc.function.name))
        && !sessionSet?.has(this.allToolsApproval)
        && !sessionSet?.has(tc.function.name)
    )

    // All calls either have an invocation-specific review or follow saved policy.
    if (needsApproval.length === 0) {
      return { approved: true }
    }

    if (conversationId) {
      this.pendingByConversation.set(taskId, conversationId)
    }

    // Emit to frontend, wait for user response (or abort)
    return new Promise<ApprovalResult>((resolve, reject) => {
      if (signal?.aborted) {
        this.pendingByConversation.delete(taskId)
        const err = new Error('Cancelled by user')
        err.name = 'AbortError'
        reject(err)
        return
      }

      const onAbort = (): void => {
        this.pendingByConversation.delete(taskId)
        const err = new Error('Cancelled by user')
        err.name = 'AbortError'
        reject(err)
      }

      signal?.addEventListener('abort', onAbort, { once: true })

      const annotatedToolCalls = needsApproval.map((toolCall) => ({
        ...toolCall,
        annotations: annotationsByName.get(toolCall.function.name),
      }))

      this.eventBus.emit('hitl:request', {
        taskId,
        conversationId,
        toolCalls: annotatedToolCalls,
        resolve: (result: ApprovalResult) => {
          this.pendingByConversation.delete(taskId)
          signal?.removeEventListener('abort', onAbort)
          resolve(result)
        }
      })
    })
  }

  /** Add session-scoped auto-approval for specific tools in a conversation. */
  addSessionApproval(conversationId: string, toolNames: string[]): void {
    let set = this.sessionApprovals.get(conversationId)
    if (!set) {
      set = this.loadSessionApprovals(conversationId)
      this.sessionApprovals.set(conversationId, set)
    }
    const now = Date.now()
    const db = getDb()
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO session_tool_approvals (conversation_id, tool_name, created_at) VALUES (?, ?, ?)'
    )
    for (const name of toolNames) {
      set.add(name)
      stmt.run(conversationId, name, now)
    }
  }

  /** Clear all session approvals for a conversation. */
  clearSessionApprovals(conversationId: string): void {
    this.sessionApprovals.delete(conversationId)
    getDb().prepare('DELETE FROM session_tool_approvals WHERE conversation_id = ?').run(conversationId)
  }

  private getSessionApprovals(conversationId: string): Set<string> {
    let set = this.sessionApprovals.get(conversationId)
    if (!set) {
      set = this.loadSessionApprovals(conversationId)
      this.sessionApprovals.set(conversationId, set)
    }
    return set
  }

  private loadSessionApprovals(conversationId: string): Set<string> {
    const rows = getDb()
      .prepare('SELECT tool_name FROM session_tool_approvals WHERE conversation_id = ?')
      .all(conversationId) as { tool_name: string }[]

    return new Set(rows.map((row) => row.tool_name))
  }
}

let hitlGateInstance: HITLGate | null = null

export function getHITLGate(): HITLGate {
  if (!hitlGateInstance) {
    hitlGateInstance = new HITLGate()
  }
  return hitlGateInstance
}
