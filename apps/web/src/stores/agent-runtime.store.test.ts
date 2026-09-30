import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatEvent } from '@shared/types'

const listTools = vi.hoisted(() => vi.fn())
vi.mock('../api/client', () => ({ api: { agent: { listTools } } }))

import { useAgentStore } from './agent-runtime.store'

describe('agent runtime hard-stop latch', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  test('ignores every late event from a stopped generation until an explicit new send', () => {
    const store = useAgentStore()
    store.setActiveViewConversation('conversation')
    store.prepareConversationExecution('conversation')
    store.handleChatExecutionState({
      executionId: 'old-execution',
      conversationId: 'conversation',
      agentId: null,
      state: 'running',
    })
    expect(store.activeConversationIsExecuting).toBe(true)

    store.stopConversationExecution('conversation', ['old-execution'])
    store.handleExecutionUpdate({
      event: 'task:started',
      data: { conversationId: 'conversation', executionId: 'old-execution', taskId: 'late-task' },
    })
    store.handleExecutionUpdate({
      event: 'step:status',
      data: { conversationId: 'conversation', executionId: 'old-execution', taskId: 'late-task', iteration: 2, status: 'executing' },
    })
    store.handleChatExecutionState({
      executionId: 'old-execution',
      conversationId: 'conversation',
      agentId: null,
      state: 'running',
    })

    expect(store.activeConversationIsExecuting).toBe(false)
    expect(store.executionSteps).toEqual([])

    store.prepareConversationExecution('conversation')
    expect(store.activeConversationIsExecuting).toBe(true)

    store.reconcileStoppedExecution('conversation', ['old-execution'])
    expect(store.activeConversationIsExecuting).toBe(true)

    // A duplicated terminal event from the old request cannot kill the new,
    // user-authorized generation while it is waiting on the conversation lock.
    store.handleChatExecutionState({
      executionId: 'old-execution',
      conversationId: 'conversation',
      agentId: null,
      state: 'stopped',
    })
    expect(store.activeConversationIsExecuting).toBe(true)

    store.handleChatExecutionState({
      executionId: 'new-execution',
      conversationId: 'conversation',
      agentId: null,
      state: 'running',
    })
    store.handleChatExecutionState({
      executionId: 'new-execution',
      conversationId: 'conversation',
      agentId: null,
      state: 'finished',
    })
    expect(store.activeConversationIsExecuting).toBe(false)
  })

  test('replayed step events deduplicate and tool updates patch the matching round', () => {
    const store = useAgentStore()
    store.setActiveViewConversation('conversation')
    const base = { version: 1 as const, conversationId: 'conversation', executionId: 'task' }
    const step = (sequence: number, iteration: number) => store.handleChatToolEvent({
      ...base, type: 'execution-step', sequence, createdAt: sequence, taskId: 'task',
      iteration, status: 'choosing-tools',
    } as ChatEvent)
    step(10, 1)
    step(20, 2)
    step(10, 1)
    store.handleChatToolEvent({ ...base, type: 'tool-calls', sequence: 11, createdAt: 11,
      items: [{ type: 'tool-call', id: 'call-1', executionId: 'task', taskId: 'task', iteration: 1,
        callId: 'call-1', name: 'lookup', arguments: '{}', createdAt: 11 }],
    } as ChatEvent)
    expect(store.executionSteps).toHaveLength(2)
    expect(store.executionSteps[0].toolCalls?.[0].name).toBe('lookup')
    expect(store.executionSteps[1].toolCalls).toBeUndefined()
  })

  test('a routing decision reduces to the same visible timeline step', () => {
    const store = useAgentStore()
    store.setActiveViewConversation('conversation')
    store.handleChatToolEvent({
      version: 1, conversationId: 'conversation', executionId: 'execution',
      sequence: 11, createdAt: 11, type: 'execution-step', taskId: 'router-task',
      iteration: 0, status: 'routing-memory',
    })
    store.handleChatToolEvent({
      version: 1, conversationId: 'conversation', executionId: 'execution',
      sequence: 12, createdAt: 12, type: 'routing-decision', taskId: 'router-task',
      phase: 'memory-context', entries: [{ name: 'notes.md', details: { type: 'memory' } }],
    })
    expect(store.executionSteps).toEqual([expect.objectContaining({
      taskId: 'router-task',
      toolCalls: [expect.objectContaining({ name: 'notes.md', arguments: '{"type":"memory"}' })],
    })])
  })
})


test('a stale tool refresh cannot hide a newly installed MCP', async () => {
  setActivePinia(createPinia())
  const store = useAgentStore()
  let resolveOld!: (tools: []) => void
  listTools.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
  const tool = { key: 'mcp:installed::search', name: 'search', executionName: 'search', description: '',
    namespace: { id: 'mcp:installed', label: 'Installed MCP' }, autoApprove: false, parameters: {}, ambiguous: false }
  listTools.mockResolvedValueOnce([tool])
  const old = store.loadTools()
  await store.loadTools()
  resolveOld([])
  await old
  expect(store.availableTools).toEqual([tool])
  store.toggleTool(tool.key)
  expect(store.selectedToolNames).toContain(tool.key)
})
