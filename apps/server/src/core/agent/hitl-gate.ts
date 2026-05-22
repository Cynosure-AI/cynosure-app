import type { ToolCall } from '../gateway/providers/base.provider.js'
import { getEventBus } from '../telemetry/event-bus.js'
import { getDb } from '../../db/database.js'
import { isOrchestrationToolName } from '../tools/builtin/orchestration-tools.js'

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

  /** Returns true if the given tool is auto-approved (whitelisted). */
  isAutoApproved(toolName: string): boolean {
    const db = getDb()
    const row = db.prepare('SELECT auto_approve FROM tool_approvals WHERE tool_name = ?').get(toolName) as { auto_approve: number } | undefined
    return row?.auto_approve === 1
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

  async requestApproval(
    taskId: string,
    toolCalls: ToolCall[],
    signal?: AbortSignal,
    conversationId?: string
  ): Promise<ApprovalResult> {
    // Filter to only tool calls that are NOT auto-approved
    // Sub-agent delegation tools (delegate_to_*) are always auto-approved —
    // the sub-agent's own tool calls hit the HITL gate independently.
    const sessionSet = conversationId ? this.getSessionApprovals(conversationId) : undefined
    const needsApproval = toolCalls.filter(
      (tc) => !tc.function.name.startsWith('delegate_to_')
        && !isOrchestrationToolName(tc.function.name)
        && !this.isAutoApproved(tc.function.name)
        && !sessionSet?.has(this.allToolsApproval)
        && !sessionSet?.has(tc.function.name)
    )

    // If every tool call is whitelisted, auto-approve
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

      this.eventBus.emit('hitl:request', {
        taskId,
        conversationId,
        toolCalls: needsApproval,
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
