import { describe, expect, it } from 'vitest'
import { buildChatTimeline } from './chat-timeline'
import type { DisplayMessage } from '../stores/chat.store'
import type { ExecutionStep } from '../stores/agent-runtime.store'

const message = (id: string, createdAt: number, extra: Partial<DisplayMessage> = {}): DisplayMessage =>
  ({ id, createdAt, role: 'assistant', content: id, ...extra })
const step = (timestamp: number, extra: Partial<ExecutionStep> = {}): ExecutionStep =>
  ({ timestamp, iteration: 1, status: 'done', taskId: `task-${timestamp}`, ...extra })
const ids = (timeline: ReturnType<typeof buildChatTimeline>) => timeline.map(entry =>
  entry.type === 'message' ? entry.msg.id : entry.type === 'sub-agent-group' ? entry.entries.map(inner => inner.key) : entry.ts)

describe('chat timeline chronology', () => {
  it('uses canonical sequence when persisted timestamps disagree', () => {
    const timeline = buildChatTimeline([
      message('later', 1, { sequence: 20 }),
      message('earlier', 2, { sequence: 10 }),
    ], [])
    expect(ids(timeline)).toEqual(['earlier', 'later'])
  })
  it('keeps a completed invocation below its own call and before a later retry', () => {
    const messages = [message('user', 0, { role: 'user' }),
      message('first-run', 2, { maInvocationId: 'first', maCodename: 'worker' }),
      message('retry', 4), message('second-run', 6, { maInvocationId: 'second', maCodename: 'worker', isStreaming: true })]
    const steps = [step(1), step(5)]
    expect(ids(buildChatTimeline(messages, steps))).toEqual(['user', 1, ['m-first-run'], 'retry', 5, ['m-second-run']])
  })

  it('does not move earlier tools when a streaming assistant finishes', () => {
    for (const isStreaming of [true, false]) {
      expect(ids(buildChatTimeline([message('answer', 3, { isStreaming })], [step(1)]))).toEqual([1, 'answer'])
    }
  })

  it('sorts out-of-order steps and isolates invocations sharing a task and iteration', () => {
    const timeline = buildChatTimeline([], [step(5, { taskId: 'same', maInvocationId: 'b' }),
      step(3, { taskId: 'same', maInvocationId: 'a' }), step(2, { taskId: 'same', maInvocationId: 'a' })])
    expect(timeline.map(entry => entry.ts)).toEqual([2, 5])
    expect(timeline[0].type).toBe('sub-agent-group')
    if (timeline[0].type !== 'sub-agent-group') return
    const inner = timeline[0].entries[0]
    expect(inner.type === 'tool-group' && inner.group.steps.map(s => s.timestamp)).toEqual([2, 3])
  })

  it('keeps interleaved parallel runs grouped until main-agent activity resumes', () => {
    const timeline = buildChatTimeline([
      message('a1', 1, { maInvocationId: 'a' }), message('b1', 2, { maInvocationId: 'b' }),
      message('main', 3), message('b2', 4, { maInvocationId: 'b' }), message('a2', 5, { maInvocationId: 'a' }),
    ], [])
    expect(ids(timeline)).toEqual([['m-a1'], ['m-b1'], 'main', ['m-b2'], ['m-a2']])
  })

  it('renders a continued invocation in a new chronological card', () => {
    const timeline = buildChatTimeline([
      message('first-run', 2, { maInvocationId: 'worker-1', maCodename: 'worker' }),
      message('main-between', 3),
      message('continued-run', 5, { maInvocationId: 'worker-1', maCodename: 'worker' }),
    ], [
      step(1, { toolCalls: [{ name: 'spawn_subagent', arguments: '{"content":"Initial task"}' }] }),
      step(4, { toolCalls: [{ name: 'continue_subagent', arguments: '{"invocationId":"worker-1","content":"Follow up"}' }] }),
    ])

    expect(ids(timeline)).toEqual([1, ['m-first-run'], 'main-between', 4, ['m-continued-run']])
    const groups = timeline.filter(entry => entry.type === 'sub-agent-group')
    expect(groups[0]?.openingMessage).toBe('Initial task')
    expect(groups[0]?.continued).toBe(false)
    expect(groups[1]?.openingMessage).toBe('Follow up')
    expect(groups[1]?.continued).toBe(true)
  })

  it('shows the model response before its delegation call and sub-agent card', () => {
    const timeline = buildChatTimeline(
      [
        message('model-response', 2),
        message('sub-answer', 3, { maInvocationId: 'worker-1', maCodename: 'worker' }),
      ],
      [step(1, { toolCalls: [{
        name: 'spawn_subagent',
        arguments: JSON.stringify({ internalName: 'worker', instructions: 'Do the task' }),
      }] })],
    )

    expect(ids(timeline)).toEqual(['model-response', 1, ['m-sub-answer']])
  })

  it('reconstructs the sub-agent first message from its regular parameters', () => {
    const timeline = buildChatTimeline(
      [message('answer', 2, { maInvocationId: 'worker-1', maCodename: 'worker' })],
      [step(1, { toolCalls: [{
        name: 'spawn_subagent',
        arguments: JSON.stringify({ internalName: 'worker', context: 'Background', instructions: 'Do the task' }),
      }] })],
    )
    const group = timeline.find(entry => entry.type === 'sub-agent-group')
    expect(group?.openingMessage).toBe('## Context\nBackground\n\n## Task\nDo the task')
  })

  it('matches parallel delegations through tool result invocation IDs', () => {
    const timeline = buildChatTimeline([
      message('second', 3, { maInvocationId: 'inv-b', maCodename: 'worker' }),
      message('first', 4, { maInvocationId: 'inv-a', maCodename: 'worker' }),
    ], [
      step(1, { taskId: 'parent', toolCalls: [
        { id: 'call-a', name: 'spawn_subagent', arguments: '{"internalName":"worker","instructions":"First task"}' },
        { id: 'call-b', name: 'spawn_subagent', arguments: '{"internalName":"worker","instructions":"Second task"}' },
      ] }),
      step(2, { taskId: 'parent', results: [
        { toolCallId: 'call-a', name: 'spawn_subagent', success: true, output: '', invocationId: 'inv-a' },
        { toolCallId: 'call-b', name: 'spawn_subagent', success: true, output: '', invocationId: 'inv-b' },
      ] }),
    ])
    const groups = timeline.filter((entry) => entry.type === 'sub-agent-group')
    expect(groups.map((entry) => [entry.entries[0].key, entry.openingMessage])).toEqual([
      ['m-second', 'Second task'], ['m-first', 'First task'],
    ])
  })

  it('keeps fallback tools inside their invocation and separates user turns', () => {
    const timeline = buildChatTimeline([
      message('a', 1, { maInvocationId: 'same' }), message('tool', 2, { role: 'tool', maInvocationId: 'same' }),
      message('user', 3, { role: 'user' }), message('b', 4, { maInvocationId: 'same' }),
    ], [])
    expect(ids(timeline)).toEqual([['m-a', 'tf-tool'], 'user', ['m-b']])
    expect(new Set(timeline.map(entry => entry.key)).size).toBe(3)
  })

  it('keeps compaction markers and equal-time messages stable without mutating inputs', () => {
    const messages = [message('a', 1), message('b', 1), message('compact', 2, {
      role: 'system', compactEventData: { summary: '', compactedMessageCount: 1, model: '', createdAt: 2 },
    }), message('answer', 4)]
    const steps = [step(3)]
    const before = JSON.stringify({ messages, steps })
    expect(ids(buildChatTimeline(messages, steps))).toEqual(['a', 'b', 2, 3, 'answer'])
    expect(JSON.stringify({ messages, steps })).toBe(before)
  })

  it('keeps continuation rounds as permanent standalone timeline markers', () => {
    const timeline = buildChatTimeline(
      [message('first-answer', 1), message('continued-answer', 4)],
      [step(2, { taskId: 'task', status: 'continuing', message: 'Open tasks remain.' }), step(3, { taskId: 'task', status: 'executing' })],
    )

    expect(timeline.map(entry => entry.type)).toEqual(['message', 'continuation', 'tool-group', 'message'])
    const marker = timeline[1]
    expect(marker.type === 'continuation' && marker.step.message).toBe('Open tasks remain.')
  })
})
