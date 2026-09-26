import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import NotificationToastHost from './NotificationToastHost.vue'

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  selectConversation: vi.fn(),
  dismissToast: vi.fn(),
  markRead: vi.fn(),
  pauseToast: vi.fn(),
  resumeToast: vi.fn(),
  toasts: [] as Array<{ id: string; agentId: string; conversationId: string | null; title: string; body: string; priority: 'notice'; read: boolean; createdAt: number }>,
}))

vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('../../stores/chat.store', () => ({ useChatStore: () => ({ selectConversation: mocks.selectConversation }) }))
vi.mock('../../stores/notification.store', () => ({ useNotificationStore: () => mocks }))

describe('NotificationToastHost', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.toasts = [{ id: 'n1', agentId: 'agent-1', conversationId: 'chat-1', title: 'Finished', body: 'Task done', priority: 'notice', read: false, createdAt: 1 }]
  })

  it('opens an associated conversation from the toast', async () => {
    const wrapper = mount(NotificationToastHost, { global: { stubs: { Icon: true, TransitionGroup: false } } })
    await wrapper.get('[aria-label="Open conversation: Finished"]').trigger('click')
    expect(mocks.selectConversation).toHaveBeenCalledWith('chat-1', 'agent-1')
    expect(mocks.push).toHaveBeenCalledWith({ name: 'conversation', params: { conversationId: 'chat-1' } })
    expect(mocks.dismissToast).toHaveBeenCalledWith('n1')
  })

  it('keeps toasts without a conversation non-interactive', async () => {
    mocks.toasts[0].conversationId = null
    const wrapper = mount(NotificationToastHost, { global: { stubs: { Icon: true, TransitionGroup: false } } })
    expect(wrapper.find('[aria-label="Open conversation: Finished"]').exists()).toBe(false)
    await wrapper.get('section').trigger('click')
    expect(mocks.push).not.toHaveBeenCalled()
    expect(mocks.selectConversation).not.toHaveBeenCalled()
  })
})
