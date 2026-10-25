import type { ToolBehaviorAnnotations, ToolCall, ToolDefinition } from '../gateway/providers/base.provider.js'
import { getEventBus } from '../telemetry/event-bus.js'
import { getDb } from '../../db/database.js'
import { isAnnotationAutoApprovedTool, isReadOnlyModeTool, isSystemAutoApprovedTool } from '../tools/tool-policy.js'
import { fileToolNeedsFolderApproval, runInFileAccessScope } from '../tools/builtin/file-access-policy.js'
import { getPermissionMode } from '../chat/permission-mode.js'
import { reviewShellCommand, type ShellCommandReview } from '../tools/builtin/shell-classifier.js'

type NamespacedTool = ToolDefinition & { namespaceId?: string; originalName?: string }

export interface ShellApprovalDetails extends ShellCommandReview {
  command: string
  explanation?: string
  cwd?: string
}

/** Reviews shell_execute calls from their command text; other calls return undefined. */
function reviewShellCall(toolCall: ToolCall, tool: NamespacedTool | undefined): ShellApprovalDetails | undefined {
  if (tool?.namespaceId !== 'builtin:shell') return undefined
  let args: Record<string, unknown>
  try { args = JSON.parse(toolCall.function.arguments) as Record<string, unknown> } catch { return undefined }
  if (typeof args.command !== 'string') return undefined
  return {
    command: args.command,
    explanation: typeof args.explanation === 'string' ? args.explanation : undefined,
    cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
    ...reviewShellCommand(args.command),
  }
}

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

  /** Whether the user saved an explicit Allow or Ask for this tool. */
  hasExplicitChoice(toolName: string): boolean {
    return Boolean(getDb().prepare('SELECT 1 FROM tool_approvals WHERE tool_name = ?').get(toolName))
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
    const permissionMode = getPermissionMode(conversationId)
    if (permissionMode === 'full') return { approved: true }

    const toolsByName = new Map(tools.map((tool) => [tool.name, tool as NamespacedTool]))
    const annotationsByName = new Map(tools.map((tool) => [tool.name, tool.annotations]))
    const shellReviews = new Map<string, ShellApprovalDetails>()
    for (const tc of toolCalls) {
      const review = reviewShellCall(tc, toolsByName.get(tc.function.name))
      if (review) shellReviews.set(tc.id, review)
    }
    // Enforce Read Only tools and its explicit exceptions, including for tools
    // offered before the chat switched to Read Only during a run.
    if (permissionMode === 'read-only') {
      const blocked = toolCalls.filter((tc) => !shellReviews.get(tc.id)?.readOnly
        && !isReadOnlyModeTool({ name: tc.function.name, annotations: annotationsByName.get(tc.function.name) }))
      if (blocked.length) {
        return {
          approved: false,
          denied: true,
          reason: `This chat is in Read Only mode, so only read-only tools and project planning can run (blocked: ${[...new Set(blocked.map((tc) => tc.function.name))].join(', ')})`,
        }
      }
    }

    // A folder card authorizes that file tool invocation, and read-only shell
    // commands need no card. All other calls use the normal tool approval policy.
    const sessionSet = conversationId ? this.getSessionApprovals(conversationId) : undefined
    const specificallyApprovedCalls = new Set<string>()
    for (const tc of toolCalls) {
      // Read-only shell commands run while the shell tool follows default
      // approval; a saved Allow or Ask applies to every command.
      if (shellReviews.get(tc.id)?.readOnly && !this.hasExplicitChoice(tc.function.name)) {
        specificallyApprovedCalls.add(tc.id)
        continue
      }
      const tool = toolsByName.get(tc.function.name)
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
        shell: shellReviews.get(toolCall.id),
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
