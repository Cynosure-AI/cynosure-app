import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { HITLRequest } from '../stores/agent-runtime.store'

const mocks = vi.hoisted(() => ({
  route: {} as { name: string; params: { conversationId?: string } },
  agent: {} as { hitlQueue: HITLRequest[] },
  chat: { conversations: [{ id: 'chat-1', agentId: 'agent-1', title: 'Research' }] },
}))

vi.mock('vue-router', () => ({ useRoute: () => mocks.route }))
vi.mock('../stores/agent-runtime.store', () => ({ useAgentStore: () => mocks.agent }))
vi.mock('../stores/chat.store', () => ({ useChatStore: () => mocks.chat }))
vi.mock('../api/client', () => ({ api: { notifications: {} } }))

import { useHITLNotifications } from './useHITLNotifications'
import { useNotificationStore } from '../stores/notification.store'

describe('HITL notifications', () => {
  let scope: ReturnType<typeof effectScope>
  const request = { taskId: 'task-1', conversationId: 'chat-1', toolCalls: [] }

  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    mocks.route = reactive({ name: 'conversation', params: { conversationId: 'other-chat' } })
    mocks.agent = reactive({ hitlQueue: [] })
    scope = effectScope()
    scope.run(useHITLNotifications)
  })

  afterEach(() => {
    scope.stop()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('shows a linked toast for 10 seconds for a background chat without persisting a notification', () => {
    const notifications = useNotificationStore()
    mocks.agent.hitlQueue = [request]
    expect(notifications.toasts).toEqual([expect.objectContaining({
      title: 'Approval needed', body: 'Research is waiting for your approval.',
      conversationId: 'chat-1', agentId: 'agent-1', transient: true,
    })])
    expect(notifications.notifications).toEqual([])
    vi.advanceTimersByTime(5000)
    expect(notifications.toasts).toHaveLength(1)
    vi.advanceTimersByTime(4999)
    expect(notifications.toasts).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(notifications.toasts).toEqual([])
  })

  it('suppresses requests for the viewed chat and requests without a conversation', () => {
    mocks.route.params.conversationId = 'chat-1'
    mocks.agent.hitlQueue = [request, { taskId: 'unknown', toolCalls: [] }]
    expect(useNotificationStore().toasts).toEqual([])
    mocks.route.params.conversationId = 'other-chat'
    expect(useNotificationStore().toasts).toEqual([])
  })

  it('notifies on other pages even when the last selected chat is the blocked chat', () => {
    mocks.route.name = 'settings'
    mocks.route.params.conversationId = 'chat-1'
    mocks.agent.hitlQueue = [request]
    expect(useNotificationStore().toasts).toHaveLength(1)
  })

  it('deduplicates pending requests and notifies again for a later gate in the same task', () => {
    mocks.agent.hitlQueue = [request]
    vi.advanceTimersByTime(10000)
    mocks.agent.hitlQueue = [{ ...request }]
    expect(useNotificationStore().toasts).toEqual([])
    mocks.agent.hitlQueue = []
    mocks.agent.hitlQueue = [request]
    expect(useNotificationStore().toasts).toHaveLength(1)
  })

  it('dismisses the toast when the chat is opened', () => {
    mocks.agent.hitlQueue = [request]
    mocks.route.params.conversationId = 'chat-1'
    expect(useNotificationStore().toasts).toEqual([])
  })

  it('dismisses resolved requests while keeping other approvals visible', () => {
    mocks.agent.hitlQueue = [request, { ...request, taskId: 'task-2' }]
    mocks.agent.hitlQueue = [request]
    expect(useNotificationStore().toasts.map((toast) => toast.id)).toEqual(['hitl:task-1'])
    mocks.agent.hitlQueue = []
    expect(useNotificationStore().toasts).toEqual([])
  })
})
