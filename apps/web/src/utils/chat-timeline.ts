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

export function buildChatTimeline(messages: DisplayMessage[], executionSteps: ExecutionStep[], mainAgentId?: string | null): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  const hasExecSteps = executionSteps.length > 0
  // Build a display-name -> codename map up front so free-chat runs (where
  // there is no main agentId to compare against) can still group sub-agent
  // stream messages with their execution cards.
  const agentNameToCodename = new Map<string, string>()
  for (const step of executionSteps) {
    if (step.maCodename && step.maAgentName) {
      agentNameToCodename.set(step.maAgentName, step.maCodename)
    }
  }
  const subAgentStepsByIdentity = new Map<string, ExecutionStep[]>()
  for (const step of executionSteps) {
    if (!step.maInvocationId) continue
    const identities = [step.maAgentName, step.maCodename].filter((value): value is string => Boolean(value))
    for (const identity of identities) {
      const current = subAgentStepsByIdentity.get(identity) || []
      current.push(step)
      subAgentStepsByIdentity.set(identity, current)
    }
  }
  for (const steps of subAgentStepsByIdentity.values()) {
    steps.sort((a, b) => a.timestamp - b.timestamp)
  }

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

    // A message is from a sub-agent if explicit multi-agent metadata is present,
    // if it has a different agentId than the orchestrator, or, in free chat,
    // if execution metadata identifies its agentName as a delegated sub-agent.
    const isSubAgent = Boolean(
      msg.maInvocationId ||
      msg.maCodename ||
      msg.maAgentName ||
      (msg.agentId && mainAgentId && msg.agentId !== mainAgentId) ||
      (!mainAgentId && msg.agentName && agentNameToCodename.has(msg.agentName))
    )

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
      const isSubAgent = steps.some(s => Boolean(s.maInvocationId || s.maCodename || s.maAgentName))
      entries.push({
        type: 'tool-group',
        group: { iteration: steps[0].iteration, steps, ts: steps[0].timestamp },
        ts: steps[0].timestamp,
        key: `tg-${groupKey}`,
        isSubAgent
      })
    }
  }

  // New activity carries the server's persisted order. Older rows retain the
  // timestamp fallback until they have canonical event sequences.
  function sequenceOf(entry: TimelineEntry): number | undefined {
    if (entry.type === 'message' || entry.type === 'tool-fallback' || entry.type === 'compact-event') return entry.msg.sequence
    if (entry.type === 'tool-group') return entry.group.steps.find((step) => step.sequence !== undefined)?.sequence
    if (entry.type === 'continuation') return entry.step.sequence
    return undefined
  }
  entries.sort((a, b) => {
    const left = sequenceOf(a)
    const right = sequenceOf(b)
    return left !== undefined && right !== undefined ? left - right : a.ts - b.ts
  })

  // ── Group sub-agent entries by invocation ───────────────────────────────

  function subAgentGroupIdOf(entry: TimelineEntry): string | null {
    if (!entry.isSubAgent) return null
    if (entry.type === 'tool-group') {
      const firstStep = entry.group.steps[0]
      return firstStep?.maInvocationId ?? firstStep?.maCodename ?? null
    }
    if (entry.type === 'message' || entry.type === 'tool-fallback') {
      return entry.msg.maInvocationId
        ?? inferSubAgentInvocationId(entry.msg)
        ?? entry.msg.maCodename
        ?? entry.msg.maAgentName
        ?? (entry.msg.agentName ? agentNameToCodename.get(entry.msg.agentName) : undefined)
        ?? entry.msg.agentName
        ?? entry.msg.agentId
        ?? null
    }
    return null
  }

  function inferSubAgentInvocationId(msg: DisplayMessage): string | null {
    const identities = [msg.agentName, msg.maCodename, msg.maAgentName].filter((value): value is string => Boolean(value))
    let best: { id: string; distance: number; before: boolean } | null = null

    for (const identity of identities) {
      for (const step of subAgentStepsByIdentity.get(identity) || []) {
        if (!step.maInvocationId) continue
        const distance = Math.abs(msg.createdAt - step.timestamp)
        const before = step.timestamp <= msg.createdAt
        if (
          !best ||
          (before && !best.before) ||
          (before === best.before && distance < best.distance)
        ) {
          best = { id: step.maInvocationId, distance, before }
        }
      }
    }

    return best?.id ?? null
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
      key: `sag-${groupId}-${innerEntries[0].ts}`
    }
  }

  function groupSubAgentEntriesForTurn(turnEntries: TimelineEntry[]): TimelineEntry[] {
    const groups = new Map<string, Extract<TimelineEntry, { type: 'sub-agent-group' }>>()
    const result: TimelineEntry[] = []
    const pendingDelegations: Delegation[] = []
    for (const entry of turnEntries) {
      if (!entry.isSubAgent) {
        result.push(entry)
        // Main-agent activity is a chronological boundary. A later
        // continuation of the same invocation gets a new card here instead
        // of being pulled back into the invocation's original card.
        groups.clear()
        pendingDelegations.push(...delegationsFrom(entry))
        continue
      }
      const groupId = subAgentGroupIdOf(entry) ?? entry.key
      const existing = groups.get(groupId)
      if (existing) {
        existing.entries.push(entry)
      } else {
        // Anchor each invocation at its first activity, immediately after its
        // initiating call, rather than collecting all runs below the last call.
        const exactIndex = pendingDelegations.findIndex(candidate =>
          candidate.invocationId === groupId || candidate.codename === groupId
        )
        const fallbackIndex = pendingDelegations.findIndex(candidate => !candidate.invocationId)
        const matchedIndex = exactIndex >= 0 ? exactIndex : fallbackIndex
        const delegation = matchedIndex >= 0 ? pendingDelegations.splice(matchedIndex, 1)[0] : null
        const group = buildSubAgentGroup(groupId, [entry], delegation)
        groups.set(groupId, group)
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
    const mergedByOwner = new Map<string, Extract<TimelineEntry, { type: 'tool-group' }>>()
    const result: TimelineEntry[] = []

    for (const entry of turnEntries) {
      if (entry.type !== 'tool-group' || entry.group.iteration !== 0) {
        result.push(entry)
        continue
      }

      const firstStep = entry.group.steps[0]
      const owner = entry.isSubAgent
        ? firstStep?.maInvocationId ?? firstStep?.maCodename ?? firstStep?.maAgentName ?? 'sub-agent'
        : 'main'
      const existing = mergedByOwner.get(owner)
      if (existing) {
        existing.group.steps.push(...entry.group.steps)
        existing.group.steps.sort((a, b) => a.timestamp - b.timestamp)
        existing.group.ts = existing.group.steps[0].timestamp
        existing.ts = existing.group.ts
        existing.key = `${existing.key}-${entry.key}`
        continue
      }

      const merged = { ...entry, group: { ...entry.group, steps: [...entry.group.steps] } }
      mergedByOwner.set(owner, merged)
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

  function putDelegationResponseBeforeCall(source: TimelineEntry[]): TimelineEntry[] {
    const result: TimelineEntry[] = []
    for (let index = 0; index < source.length; index++) {
      const call = source[index]
      const response = source[index + 1]
      const subAgent = source[index + 2]
      if (
        call?.type === 'tool-group' &&
        delegationsFrom(call).length > 0 &&
        response?.type === 'message' &&
        response.msg.role === 'assistant' &&
        !response.isSubAgent &&
        subAgent?.type === 'sub-agent-group'
      ) {
        // The assistant text and tool call are emitted in that order by the
        // model, but the completed tool step has an earlier persisted
        // timestamp. Restore the conversational order for delegation rounds.
        result.push(response, call, subAgent)
        index += 2
        continue
      }
      result.push(call)
    }
    return result
  }

  return putDelegationResponseBeforeCall(groupSubAgentEntriesByTurn(mergePreTurnGroupsByTurn(entries)))
}
