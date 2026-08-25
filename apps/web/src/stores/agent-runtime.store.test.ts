import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../api/client', () => ({ api: {} }))

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
})
