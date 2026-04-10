import type { ToolCall } from '../gateway/providers/base.provider.js'
import { getEventBus } from '../telemetry/event-bus.js'
import { getDb } from '../../db/database.js'

export interface ApprovalResult {
  approved: boolean
  denied?: boolean
  reason?: string
}

export class HITLGate {
  private eventBus = getEventBus()
  private pendingByConversation = new Map<string, string>() // taskId → conversationId
  private sessionApprovals = new Map<string, Set<string>>() // conversationId → Set<toolName>

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
    const sessionSet = conversationId ? this.sessionApprovals.get(conversationId) : undefined
    const needsApproval = toolCalls.filter(
      (tc) => !tc.function.name.startsWith('delegate_to_') && !this.isAutoApproved(tc.function.name) && !sessionSet?.has(tc.function.name)
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
      set = new Set()
      this.sessionApprovals.set(conversationId, set)
    }
    for (const name of toolNames) {
      set.add(name)
    }
  }

  /** Clear all session approvals for a conversation. */
  clearSessionApprovals(conversationId: string): void {
    this.sessionApprovals.delete(conversationId)
  }
}

let hitlGateInstance: HITLGate | null = null

export function getHITLGate(): HITLGate {
  if (!hitlGateInstance) {
    hitlGateInstance = new HITLGate()
  }
  return hitlGateInstance
}
