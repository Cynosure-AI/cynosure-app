// Folds each delegation into one timeline entry: the main agent's
// spawn/continue call, everything its sub-agents did, and what came back.
//
// buildChatTimeline keeps those apart on purpose (the call card, one box per
// stretch of uninterrupted sub-agent activity, a separate return marker), so
// interleaved work stays chronological. Here they are regrouped per run: one
// card per delegation, one row per sub-agent invocation inside it.

import type { TimelineEntry } from './chat-timeline'
import type { ExecutionStep } from '../stores/agent-runtime.store'

type ToolGroupEntry = Extract<TimelineEntry, { type: 'tool-group' }>
type SubAgentGroupEntry = Extract<TimelineEntry, { type: 'sub-agent-group' }>
type ToolCall = NonNullable<ExecutionStep['toolCalls']>[number]
export type DelegationToolResult = NonNullable<ExecutionStep['results']>[number]

export const DELEGATION_TOOLS = new Set(['spawn_subagent', 'continue_subagent'])

/** One sub-agent invocation within a delegation. */
export interface SubAgentRun {
  key: string
  invocationId: string | null
  codename: string
  agentName: string | null
  agentId: string | null
  /** The task as the sub-agent received it. */
  openingMessage: string | null
  /** Picks up an earlier session through continue_subagent. */
  continued: boolean
  /** The sub-agent's messages and tool cards, in order. */
  entries: TimelineEntry[]
  /** What the spawn/continue call returned, once the main agent has it. */
  result?: DelegationToolResult
}

export interface DelegationEntry {
  type: 'delegation'
  key: string
  ts: number
  isSubAgent?: false
  /** The main agent's tool card that requested the delegation; absent when only sub-agent activity survived. */
  call: ToolGroupEntry | null
  runs: SubAgentRun[]
}

export type DisplayTimelineEntry = Exclude<TimelineEntry, { type: 'sub-agent-group' }> | DelegationEntry

interface DelegationRequest {
  invocationId: string | null
  codename: string | null
  task: string
  continued: boolean
  result?: DelegationToolResult
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function resultInvocationId(result?: DelegationToolResult): string | null {
  if (!result) return null
  if (result.invocationId) return result.invocationId
  const structured = result.structuredContent as { invocationId?: unknown } | undefined
  return structured && typeof structured.invocationId === 'string' ? structured.invocationId : null
}

/** Calls a tool card made, without the repeats later status steps carry. */
export function uniqueToolCalls(call: ToolGroupEntry): ToolCall[] {
  const seen = new Set<string>()
  return call.group.steps.flatMap((step) => step.toolCalls || []).filter((toolCall) => {
    const key = toolCall.id || `${toolCall.name}:${toolCall.arguments}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** The newest result for each call ID; later steps restate earlier ones. */
export function toolResultsById(call: ToolGroupEntry): Map<string, DelegationToolResult> {
  const results = new Map<string, DelegationToolResult>()
  for (const step of call.group.steps) {
    for (const result of step.results || []) {
      if (result.toolCallId) results.set(result.toolCallId, result)
    }
  }
  return results
}

function requestsOf(call: ToolGroupEntry): DelegationRequest[] {
  const results = toolResultsById(call)
  return uniqueToolCalls(call).filter((toolCall) => DELEGATION_TOOLS.has(toolCall.name)).map((toolCall) => {
    const args = parseArgs(toolCall.arguments)
    const result = toolCall.id ? results.get(toolCall.id) : undefined
    return {
      invocationId: text(args.invocationId) || resultInvocationId(result),
      codename: text(args.internalName) || null,
      task: text(args.content) || text(args.instructions),
      continued: toolCall.name === 'continue_subagent',
      result,
    }
  })
}

/** The main agent's tool card when it requested a sub-agent. */
function handoffOf(entry: TimelineEntry): ToolGroupEntry | null {
  if (entry.type !== 'tool-group' || entry.isSubAgent) return null
  return entry.group.steps.some((step) => step.toolCalls?.some((toolCall) => DELEGATION_TOOLS.has(toolCall.name)))
    ? entry
    : null
}

function runFromGroup(group: SubAgentGroupEntry): SubAgentRun {
  return {
    key: group.key,
    invocationId: group.invocationId,
    codename: group.codename,
    agentName: group.agentName,
    agentId: group.agentId,
    openingMessage: group.openingMessage,
    continued: group.continued,
    entries: [...group.entries],
  }
}

function addGroup(delegation: DelegationEntry, group: SubAgentGroupEntry): void {
  const existing = group.invocationId
    ? delegation.runs.find((run) => run.invocationId === group.invocationId)
    : undefined
  if (!existing) {
    delegation.runs.push(runFromGroup(group))
    return
  }
  existing.entries.push(...group.entries)
  existing.agentName ??= group.agentName
  existing.agentId ??= group.agentId
  existing.openingMessage ??= group.openingMessage
}

/** Pairs each requested call with the run it produced and adds rows for runs that have not started. */
function settleRequests(delegation: DelegationEntry): void {
  if (!delegation.call) return
  const requests = requestsOf(delegation.call)
  const unused = new Set(requests.map((_, index) => index))
  const take = (predicate: (request: DelegationRequest) => boolean): DelegationRequest | undefined => {
    for (const index of unused) {
      if (!predicate(requests[index])) continue
      unused.delete(index)
      return requests[index]
    }
    return undefined
  }

  for (const run of delegation.runs) {
    const request = (run.invocationId ? take((candidate) => candidate.invocationId === run.invocationId) : undefined)
      ?? (run.openingMessage ? take((candidate) => Boolean(candidate.task) && run.openingMessage!.includes(candidate.task)) : undefined)
      ?? take((candidate) => !candidate.invocationId && candidate.codename === run.codename)
      ?? take((candidate) => !candidate.invocationId)
    if (!request) continue
    run.result = request.result
    run.continued ||= request.continued
    run.invocationId ??= request.invocationId
    run.openingMessage ??= request.task || null
  }

  for (const index of unused) {
    const request = requests[index]
    delegation.runs.push({
      key: `${delegation.key}-request-${index}`,
      invocationId: request.invocationId,
      codename: request.codename ?? request.invocationId ?? 'sub-agent',
      agentName: null,
      agentId: null,
      openingMessage: request.task || null,
      continued: request.continued,
      entries: [],
      result: request.result,
    })
  }
}

export function groupDelegations(timeline: TimelineEntry[]): DisplayTimelineEntry[] {
  const result: DisplayTimelineEntry[] = []
  const delegations: DelegationEntry[] = []
  let open: DelegationEntry | null = null

  const start = (call: ToolGroupEntry | null, key: string, ts: number): DelegationEntry => {
    const delegation: DelegationEntry = { type: 'delegation', key, ts, call, runs: [] }
    delegations.push(delegation)
    result.push(delegation)
    return delegation
  }

  for (const entry of timeline) {
    const handoff = handoffOf(entry)
    if (handoff) {
      open = start(handoff, `dl-${handoff.key}`, handoff.ts)
      continue
    }
    if (entry.type === 'sub-agent-group') {
      // Activity whose call is missing still gets the same card.
      open ??= start(null, `dl-${entry.key}`, entry.ts)
      addGroup(open, entry)
      continue
    }
    if (entry.type === 'delegation-result' && open?.call) {
      // The returned results are read from the call itself.
      open = null
      continue
    }
    // The main agent moving on ends the delegation; its own replies in between do not.
    if (
      (entry.type === 'message' && entry.msg.role === 'user')
      || (entry.type === 'tool-group' && !entry.isSubAgent)
      || entry.type === 'continuation'
    ) open = null
    result.push(entry)
  }

  for (const delegation of delegations) settleRequests(delegation)
  return result
}
