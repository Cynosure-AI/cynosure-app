import { describe, expect, it } from 'vitest'
import { buildChatTimeline } from './chat-timeline'
import { groupDelegations, type DelegationEntry } from './delegation-timeline'
import type { DisplayMessage } from '../stores/chat.store'
import type { ExecutionStep } from '../stores/agent-runtime.store'

const message = (id: string, createdAt: number, extra: Partial<DisplayMessage> = {}): DisplayMessage =>
  ({ id, createdAt, role: 'assistant', content: id, ...extra })
const step = (timestamp: number, extra: Partial<ExecutionStep> = {}): ExecutionStep =>
  ({ timestamp, iteration: 1, status: 'done', taskId: `task-${timestamp}`, ...extra })
const shape = (messages: DisplayMessage[], steps: ExecutionStep[]) =>
  groupDelegations(buildChatTimeline(messages, steps))
const kinds = (timeline: ReturnType<typeof groupDelegations>) =>
  timeline.map((entry) => entry.type === 'message' ? entry.msg.id : entry.type)
const delegations = (timeline: ReturnType<typeof groupDelegations>) =>
  timeline.filter((entry): entry is DelegationEntry => entry.type === 'delegation')

describe('groupDelegations', () => {
  it('folds the call, the sub-agent activity and its return into one card', () => {
    const timeline = shape([
      message('handoff', 2, { toolCallIds: ['delegate-1'] }),
      message('sub-agent work', 4, { maInvocationId: 'worker-1', maCodename: 'worker' }),
      message('main follow-up', 7),
    ], [
      step(1, { taskId: 'parent', toolCalls: [{ id: 'delegate-1', name: 'spawn_subagent', arguments: '{"internalName":"worker","instructions":"Do the task"}' }] }),
      step(3, { taskId: 'parent', status: 'executing', resultsAt: 6, results: [
        { toolCallId: 'delegate-1', name: 'spawn_subagent', success: true, output: 'Done', invocationId: 'worker-1' },
      ] }),
    ])

    expect(kinds(timeline)).toEqual(['handoff', 'delegation', 'main follow-up'])
    const [card] = delegations(timeline)
    expect(card.runs).toHaveLength(1)
    expect(card.runs[0]).toMatchObject({ invocationId: 'worker-1', codename: 'worker', openingMessage: 'Do the task', continued: false })
    expect(card.runs[0].entries.map((entry) => entry.key)).toEqual(['m-sub-agent work'])
    expect(card.runs[0].result?.success).toBe(true)
  })

  it('merges interleaved stretches of the same invocation into one row per sub-agent', () => {
    const timeline = shape([
      message('a1', 2, { maInvocationId: 'inv-a', maCodename: 'alpha' }),
      message('b1', 3, { maInvocationId: 'inv-b', maCodename: 'beta' }),
      message('a2', 4, { maInvocationId: 'inv-a', maCodename: 'alpha' }),
    ], [
      step(1, { taskId: 'parent', toolCalls: [
        { id: 'call-a', name: 'spawn_subagent', arguments: '{"internalName":"alpha","instructions":"First"}' },
        { id: 'call-b', name: 'spawn_subagent', arguments: '{"internalName":"beta","instructions":"Second"}' },
      ] }),
    ])

    const [card] = delegations(timeline)
    expect(delegations(timeline)).toHaveLength(1)
    expect(card.runs.map((run) => [run.codename, run.openingMessage, run.entries.map((entry) => entry.key)])).toEqual([
      ['alpha', 'First', ['m-a1', 'm-a2']],
      ['beta', 'Second', ['m-b1']],
    ])
  })

  it('lists requested sub-agents that have not started yet', () => {
    const timeline = shape([
      message('a1', 2, { maInvocationId: 'inv-a', maCodename: 'alpha' }),
    ], [
      step(1, { taskId: 'parent', toolCalls: [
        { id: 'call-a', name: 'spawn_subagent', arguments: '{"internalName":"alpha","instructions":"First"}' },
        { id: 'call-b', name: 'spawn_subagent', arguments: '{"internalName":"beta","instructions":"Second"}' },
      ] }),
    ])

    const [card] = delegations(timeline)
    expect(card.runs.map((run) => [run.codename, run.entries.length])).toEqual([['alpha', 1], ['beta', 0]])
    expect(card.runs[1].openingMessage).toBe('Second')
  })

  it('gives a continued session its own card marked as continued', () => {
    const timeline = shape([
      message('first-run', 2, { maInvocationId: 'worker-1', maCodename: 'worker' }),
      message('main-between', 3),
      message('continued-run', 5, { maInvocationId: 'worker-1', maCodename: 'worker' }),
    ], [
      step(1, { toolCalls: [{ name: 'spawn_subagent', arguments: '{"content":"Initial task"}' }] }),
      step(4, { toolCalls: [{ name: 'continue_subagent', arguments: '{"invocationId":"worker-1","content":"Follow up"}' }] }),
    ])

    expect(kinds(timeline)).toEqual(['delegation', 'main-between', 'delegation'])
    const [first, second] = delegations(timeline)
    expect(first.runs.map((run) => [run.continued, run.openingMessage])).toEqual([[false, 'Initial task']])
    expect(second.runs.map((run) => [run.continued, run.openingMessage])).toEqual([[true, 'Follow up']])
  })

  it('pairs parallel results with their runs through invocation IDs', () => {
    const timeline = shape([
      message('second', 3, { maInvocationId: 'inv-b', maCodename: 'worker' }),
      message('first', 4, { maInvocationId: 'inv-a', maCodename: 'worker' }),
    ], [
      step(1, { taskId: 'parent', toolCalls: [
        { id: 'call-a', name: 'spawn_subagent', arguments: '{"internalName":"worker","instructions":"First task"}' },
        { id: 'call-b', name: 'spawn_subagent', arguments: '{"internalName":"worker","instructions":"Second task"}' },
      ] }),
      step(2, { taskId: 'parent', results: [
        { toolCallId: 'call-a', name: 'spawn_subagent', success: true, output: '', invocationId: 'inv-a' },
        { toolCallId: 'call-b', name: 'spawn_subagent', success: false, output: '', error: 'Boom', invocationId: 'inv-b' },
      ] }),
    ])

    const [card] = delegations(timeline)
    expect(card.runs.map((run) => [run.invocationId, run.openingMessage, run.result?.success])).toEqual([
      ['inv-b', 'Second task', false], ['inv-a', 'First task', true],
    ])
  })

  it('wraps sub-agent activity without a recorded call in the same card', () => {
    const timeline = shape([message('orphan', 2, { maInvocationId: 'inv', maCodename: 'worker' })], [])
    expect(kinds(timeline)).toEqual(['delegation'])
    expect(delegations(timeline)[0].call).toBeNull()
  })

  it('ends a delegation once the main agent moves on to other tools', () => {
    const timeline = shape([
      message('a', 2, { maInvocationId: 'first', maCodename: 'worker' }),
      message('b', 5, { maInvocationId: 'second', maCodename: 'worker' }),
    ], [
      step(1, { taskId: 'parent', toolCalls: [{ id: 'spawn', name: 'spawn_subagent', arguments: '{"instructions":"Go"}' }] }),
      step(3, { taskId: 'parent', iteration: 2, toolCalls: [{ id: 'read', name: 'read_file', arguments: '{}' }] }),
    ])
    expect(kinds(timeline)).toEqual(['delegation', 'tool-group', 'delegation'])
  })

  it('ends a delegation when the user speaks again', () => {
    const timeline = shape([
      message('a', 2, { maInvocationId: 'same' }),
      message('user', 3, { role: 'user' }),
      message('b', 4, { maInvocationId: 'same' }),
    ], [step(1, { toolCalls: [{ name: 'spawn_subagent', arguments: '{"instructions":"Go"}' }] })])
    expect(kinds(timeline)).toEqual(['delegation', 'user', 'delegation'])
  })
})
