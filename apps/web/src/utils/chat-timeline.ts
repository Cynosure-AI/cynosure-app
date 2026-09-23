import type { DisplayMessage } from '../stores/chat.store'
import type { ExecutionStep } from '../stores/agent-runtime.store'

interface ToolGroup {
  iteration: number
  steps: ExecutionStep[]
  ts: number
}

export type TimelineEntry =
  | { type: 'message'; msg: DisplayMessage; ts: number; key: string; isSubAgent?: boolean }
  | { type: 'tool-group'; group: ToolGroup; ts: number; key: string; isSubAgent?: boolean }
  | { type: 'continuation'; step: ExecutionStep; ts: number; key: string; isSubAgent?: false }
  | { type: 'tool-fallback'; msg: DisplayMessage; ts: number; key: string; isSubAgent?: boolean }
  | { type: 'compact-event'; msg: DisplayMessage; ts: number; key: string; isSubAgent?: false }
  | { type: 'sub-agent-group'; codename: string; agentName: string | null; agentId: string | null; openingMessage: string | null; continued: boolean; entries: TimelineEntry[]; ts: number; key: string; isSubAgent?: false }

export function buildChatTimeline(messages: DisplayMessage[], executionSteps: ExecutionStep[]): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  const hasExecSteps = executionSteps.length > 0

  for (const msg of messages) {
    // Compact event markers — rendered as divider cards, not regular messages
    if (msg.compactEventData) {
      entries.push({ type: 'compact-event', msg, ts: msg.createdAt, key: `ce-${msg.id}` })
      continue
    }
    // Skip plain system messages (agent prompts etc. are not shown to user)
    if (msg.role === 'system') continue
    // When we have execution steps, hide tool messages (shown via ToolExecutionCard)
    if (hasExecSteps && msg.role === 'tool') continue
    // Always hide empty assistant messages (tool-calling bookkeeping, no visible content)
    if (
      msg.role === 'assistant' &&
      !msg.content &&
      !msg.thinking &&
      !msg.imageDataUrls?.length &&
      !msg.videoDataUrls?.length &&
      !msg.isStreaming &&
      !msg.isError
    ) continue

    const isSubAgent = Boolean(msg.maInvocationId)

    if (msg.role === 'tool') {
      // No exec steps available — render tool messages as compact fallback cards
      entries.push({ type: 'tool-fallback', msg, ts: msg.createdAt, key: `tf-${msg.id}`, isSubAgent })
    } else {
      entries.push({ type: 'message', msg, ts: msg.createdAt, key: `m-${msg.id}`, isSubAgent })
    }
  }

  if (hasExecSteps) {
    // Group steps by taskId + iteration to keep outer and inner executor steps separate
    const grouped = new Map<string, ExecutionStep[]>()
    for (const step of executionSteps) {
      if (step.status === 'continuing') {
        entries.push({
          type: 'continuation',
          step,
          ts: step.timestamp,
          key: `continuation-${step.taskId ?? 'task'}-${step.timestamp}`,
        })
        continue
      }
      const groupKey = JSON.stringify([step.maInvocationId ?? step.maCodename ?? '', step.taskId ?? '', step.iteration])
      if (!grouped.has(groupKey)) grouped.set(groupKey, [])
      grouped.get(groupKey)!.push(step)
    }
    for (const [groupKey, steps] of grouped) {
      // A tool-group is from a sub-agent if any step has maCodename set
      steps.sort((a, b) => a.timestamp - b.timestamp)
      const isSubAgent = steps.some(s => Boolean(s.maInvocationId))
      entries.push({
        type: 'tool-group',
        group: { iteration: steps[0].iteration, steps, ts: steps[0].timestamp },
        ts: steps[0].timestamp,
        key: `tg-${groupKey}`,
        isSubAgent
      })
    }
  }

  // The timestamps shown in the chat are the timeline's ordering authority.
  // Event sequence records persistence order, which can differ from when a
  // message or tool step actually happened. Use it only for equal timestamps.
  function sequenceOf(entry: TimelineEntry): number | undefined {
    if (entry.type === 'message' || entry.type === 'tool-fallback' || entry.type === 'compact-event') return entry.msg.sequence
    if (entry.type === 'tool-group') return entry.group.steps.find((step) => step.sequence !== undefined)?.sequence
    if (entry.type === 'continuation') return entry.step.sequence
    return undefined
  }
  entries.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts
    const left = sequenceOf(a)
    const right = sequenceOf(b)
    if (left !== undefined && right !== undefined) return left - right
    if (left !== undefined) return -1
    if (right !== undefined) return 1
    return 0
  })

  // The executor logs "choosing tools" before it persists the assistant's
  // tool-calling message. Match their call IDs so the card follows the message
  // that requested it, including when loading an older saved conversation.
  const messageByCallId = new Map<string, Extract<TimelineEntry, { type: 'message' }>>()
  for (const entry of entries) {
    if (entry.type !== 'message' || entry.msg.role !== 'assistant') continue
    for (const id of entry.msg.toolCallIds || []) messageByCallId.set(id, entry)
  }
  const linkedGroups = entries.flatMap((entry) => {
    if (entry.type !== 'tool-group') return []
    const message = entry.group.steps.flatMap((step) => step.toolCalls || [])
      .map((call) => call.id && messageByCallId.get(call.id))
      .find((candidate) => candidate !== undefined)
    return message ? [{ group: entry, message }] : []
  })
  for (const { group, message } of linkedGroups.reverse()) {
    const groupIndex = entries.indexOf(group)
    if (groupIndex > entries.indexOf(message)) continue
    entries.splice(groupIndex, 1)
    entries.splice(entries.indexOf(message) + 1, 0, group)
  }

  // ── Group sub-agent entries by invocation ───────────────────────────────

  function subAgentGroupIdOf(entry: TimelineEntry): string | null {
    if (!entry.isSubAgent) return null
    if (entry.type === 'tool-group') {
      const firstStep = entry.group.steps[0]
      return firstStep?.maInvocationId ?? null
    }
    if (entry.type === 'message' || entry.type === 'tool-fallback') {
      return entry.msg.maInvocationId ?? null
    }
    return null
  }

  type Delegation = { invocationId: string | null; codename: string | null; content: string; continued: boolean }

  function delegationsFrom(entry: TimelineEntry): Delegation[] {
    if (entry.type !== 'tool-group') return []
    const delegations: Delegation[] = []
    const resultsByCallId = new Map(entry.group.steps.flatMap((step) => step.results || [])
      .filter((result) => result.toolCallId).map((result) => [result.toolCallId!, result]))
    for (const step of entry.group.steps) {
      for (const call of step.toolCalls || []) {
        if (call.name !== 'spawn_subagent' && call.name !== 'continue_subagent') continue
        try {
          const args = JSON.parse(call.arguments || '{}') as Record<string, unknown>
          const directContent = typeof args.content === 'string' ? args.content.trim() : ''
          const instructions = typeof args.instructions === 'string' ? args.instructions.trim() : ''
          const context = typeof args.context === 'string' ? args.context.trim() : ''
          const continued = call.name === 'continue_subagent'
          const result = call.id ? resultsByCallId.get(call.id) : undefined
          const resultInvocationId = result?.invocationId || (result?.structuredContent && typeof result.structuredContent === 'object'
            ? (result.structuredContent as { invocationId?: string }).invocationId : undefined)
          const content = directContent || (context
            ? `${continued ? '## New Context' : '## Context'}\n${context}\n\n${continued ? '## Follow-up Task' : '## Task'}\n${instructions}`
            : instructions)
          delegations.push({
            invocationId: typeof args.invocationId === 'string' ? args.invocationId : resultInvocationId || null,
            codename: typeof args.internalName === 'string' ? args.internalName : null,
            content,
            continued,
          })
        } catch {
          continue
        }
      }
    }
    return delegations
  }

  function buildSubAgentGroup(
    groupId: string,
    innerEntries: TimelineEntry[],
    delegation?: Delegation | null,
  ): Extract<TimelineEntry, { type: 'sub-agent-group' }> {
    let agentName: string | null = null
    let agentId: string | null = null
    let codename: string | null = null
    for (const e of innerEntries) {
      if ((e.type === 'message' || e.type === 'tool-fallback') && e.msg.agentName) agentName = agentName ?? e.msg.agentName
      if ((e.type === 'message' || e.type === 'tool-fallback') && e.msg.agentId) agentId = agentId ?? e.msg.agentId
      if ((e.type === 'message' || e.type === 'tool-fallback') && e.msg.maCodename) codename = codename ?? e.msg.maCodename
      if ((e.type === 'message' || e.type === 'tool-fallback') && e.msg.maAgentName) agentName = agentName ?? e.msg.maAgentName
      if (e.type === 'tool-group' && e.group.steps[0]?.maAgentName) agentName = agentName ?? e.group.steps[0].maAgentName
      if (e.type === 'tool-group' && e.group.steps[0]?.maCodename) codename = codename ?? e.group.steps[0].maCodename
      if (agentName && agentId && codename) break
    }
    return {
      type: 'sub-agent-group',
      codename: codename ?? groupId,
      agentName,
      agentId,
      openingMessage: delegation?.content || null,
      continued: delegation?.continued ?? false,
      entries: innerEntries,
      ts: innerEntries[0].ts,
      key: `sag-${groupId}-${innerEntries[0].key}`
    }
  }

  function groupSubAgentEntriesForTurn(turnEntries: TimelineEntry[]): TimelineEntry[] {
    const result: TimelineEntry[] = []
    const pendingDelegations: Delegation[] = []
    let currentGroup: Extract<TimelineEntry, { type: 'sub-agent-group' }> | null = null
    let currentGroupId: string | null = null
    for (const entry of turnEntries) {
      if (!entry.isSubAgent) {
        result.push(entry)
        currentGroup = null
        currentGroupId = null
        pendingDelegations.push(...delegationsFrom(entry))
        continue
      }
      const groupId = subAgentGroupIdOf(entry) ?? entry.key
      if (currentGroup && currentGroupId === groupId) {
        currentGroup.entries.push(entry)
      } else {
        // A different invocation is a chronological boundary, even when the
        // previous invocation has more activity later in the same turn.
        const exactIndex = pendingDelegations.findIndex(candidate =>
          candidate.invocationId === groupId || candidate.codename === groupId
        )
        const fallbackIndex = pendingDelegations.findIndex(candidate => !candidate.invocationId)
        const matchedIndex = exactIndex >= 0 ? exactIndex : fallbackIndex
        const delegation = matchedIndex >= 0 ? pendingDelegations.splice(matchedIndex, 1)[0] : null
        const group = buildSubAgentGroup(groupId, [entry], delegation)
        currentGroup = group
        currentGroupId = groupId
        result.push(group)
      }
    }
    return result.map(entry => entry.type === 'sub-agent-group'
      ? {
          ...buildSubAgentGroup(entry.codename, entry.entries, {
            invocationId: null,
            codename: entry.codename,
            content: entry.openingMessage || '',
            continued: entry.continued,
          }),
          key: entry.key,
        }
      : entry)
  }

  function groupSubAgentEntriesByTurn(source: TimelineEntry[]): TimelineEntry[] {
    const result: TimelineEntry[] = []
    let turnEntries: TimelineEntry[] = []

    const flushTurn = () => {
      if (!turnEntries.length) return
      result.push(...groupSubAgentEntriesForTurn(turnEntries))
      turnEntries = []
    }

    for (const entry of source) {
      if (entry.type === 'message' && entry.msg.role === 'user') {
        flushTurn()
      }
      turnEntries.push(entry)
    }
    flushTurn()

    return result
  }

  function mergePreTurnGroupsForTurn(turnEntries: TimelineEntry[]): TimelineEntry[] {
    const result: TimelineEntry[] = []
    const ownerOf = (entry: Extract<TimelineEntry, { type: 'tool-group' }>): string => {
      if (!entry.isSubAgent) return 'main'
      const firstStep = entry.group.steps[0]
      return firstStep?.maInvocationId ?? firstStep?.maCodename ?? firstStep?.maAgentName ?? 'sub-agent'
    }

    for (const entry of turnEntries) {
      if (entry.type !== 'tool-group' || entry.group.iteration !== 0) {
        result.push(entry)
        continue
      }

      const previous = result.at(-1)
      // A visible entry between preparation cards is a chronological boundary.
      const existing = previous?.type === 'tool-group' && previous.group.iteration === 0
        && ownerOf(previous) === ownerOf(entry) ? previous : null
      if (existing) {
        existing.group.steps.push(...entry.group.steps)
        existing.group.steps.sort((a, b) => a.timestamp - b.timestamp)
        existing.group.ts = existing.group.steps[0].timestamp
        existing.ts = existing.group.ts
        existing.key = `${existing.key}-${entry.key}`
        continue
      }

      const merged = { ...entry, group: { ...entry.group, steps: [...entry.group.steps] } }
      result.push(merged)
    }

    return result
  }

  function mergePreTurnGroupsByTurn(source: TimelineEntry[]): TimelineEntry[] {
    const result: TimelineEntry[] = []
    let turnEntries: TimelineEntry[] = []
    const flushTurn = () => {
      if (!turnEntries.length) return
      result.push(...mergePreTurnGroupsForTurn(turnEntries))
      turnEntries = []
    }

    for (const entry of source) {
      if (entry.type === 'message' && entry.msg.role === 'user') flushTurn()
      turnEntries.push(entry)
    }
    flushTurn()
    return result
  }

  return groupSubAgentEntriesByTurn(mergePreTurnGroupsByTurn(entries))
}
