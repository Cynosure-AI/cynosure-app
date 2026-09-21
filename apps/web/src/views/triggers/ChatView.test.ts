import { shallowMount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import InputBar from '../../components/chat/InputBar.vue'
import ChatPanel from '../../components/chat/ChatPanel.vue'
import ChatView from './ChatView.vue'

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  providerStore: { providers: [] as Array<{ id: string }>, providersLoaded: true },
  chatStore: {
    activeConversationId: null as string | null,
    loadingMessages: false,
    messages: [],
    activeAgentId: null,
    conversations: [],
    markConversationRead: vi.fn(),
    selectConversation: vi.fn(),
  },
  agentStore: { planningState: null },
  route: { params: {}, name: 'triggers-chat' },
  wsConnected: { __v_isRef: true, value: true },
}))

vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
}))

vi.mock('../../stores/chat.store', () => ({ useChatStore: () => mocks.chatStore }))
vi.mock('../../stores/agent-runtime.store', () => ({ useAgentStore: () => mocks.agentStore }))
vi.mock('../../stores/provider.store', () => ({ useProviderStore: () => mocks.providerStore }))
vi.mock('../../api/http', () => ({ wsConnected: mocks.wsConnected }))

describe('ChatView provider availability', () => {
  beforeEach(() => {
    mocks.push.mockReset()
    mocks.providerStore.providers = []
    mocks.providerStore.providersLoaded = true
    mocks.wsConnected.value = true
  })

  test('replaces the chat and composer with provider setup guidance', async () => {
    const wrapper = shallowMount(ChatView, { global: { stubs: { Icon: true } } })

    expect(wrapper.get('[data-testid="chat-no-providers"]').text()).toContain('Set up an AI provider')
    expect(wrapper.findComponent(InputBar).exists()).toBe(false)
    expect(wrapper.findComponent(ChatPanel).exists()).toBe(false)

    await wrapper.get('[data-testid="chat-no-providers"] button').trigger('click')
    expect(mocks.push).toHaveBeenCalledWith({ name: 'settings', query: { category: 'providers' } })
  })

  test('renders the normal chat once a provider exists', () => {
    mocks.providerStore.providers = [{ id: 'provider-1' }]
    const wrapper = shallowMount(ChatView, { global: { stubs: { Icon: true } } })

    expect(wrapper.find('[data-testid="chat-no-providers"]').exists()).toBe(false)
    expect(wrapper.findComponent(InputBar).exists()).toBe(true)
    expect(wrapper.findComponent(ChatPanel).exists()).toBe(true)
  })

  test('shows initialising until the server connects, even when providers appear empty', () => {
    mocks.wsConnected.value = false
    const wrapper = shallowMount(ChatView, { global: { stubs: { Icon: true } } })

    expect(wrapper.get('[data-testid="chat-initialising"]').findComponent(ChatPanel).exists()).toBe(true)
    expect(wrapper.find('[data-testid="chat-no-providers"]').exists()).toBe(false)
    expect(wrapper.findComponent(InputBar).exists()).toBe(false)
  })
})
