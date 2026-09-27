import { shallowMount } from '@vue/test-utils'
import { nextTick } from 'vue'
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
    messages: [] as Array<{ role: string; content: string }>,
    activeAgentId: null,
    conversations: [],
    markConversationRead: vi.fn(),
    selectConversation: vi.fn(),
  },
  agentStore: { planningState: null },
  route: { params: {}, name: 'triggers-chat' },
  wsConnected: { __v_isRef: true, value: true },
  agentsList: vi.fn(),
  embeddingConfig: vi.fn(),
  mcpServers: vi.fn(),
}))

vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
}))

vi.mock('../../stores/chat.store', () => ({ useChatStore: () => mocks.chatStore }))
vi.mock('../../stores/agent-runtime.store', () => ({ useAgentStore: () => mocks.agentStore }))
vi.mock('../../stores/provider.store', () => ({ useProviderStore: () => mocks.providerStore }))
vi.mock('../../api/http', () => ({ wsConnected: mocks.wsConnected }))
vi.mock('../../api/client', () => ({ api: {
  agents: { list: mocks.agentsList },
  memory: { getEmbeddingConfig: mocks.embeddingConfig },
  mcp: { listServers: mocks.mcpServers },
} }))

describe('ChatView provider availability', () => {
  beforeEach(() => {
    mocks.push.mockReset()
    mocks.providerStore.providers = []
    mocks.providerStore.providersLoaded = true
    mocks.wsConnected.value = true
    mocks.chatStore.messages = []
    mocks.chatStore.activeConversationId = null
    mocks.chatStore.activeAgentId = null
    mocks.chatStore.conversations = []
    mocks.agentsList.mockReset().mockResolvedValue([{ id: 'agent-1' }])
    mocks.embeddingConfig.mockReset().mockResolvedValue({ providerId: 'provider-1', model: 'embed' })
    mocks.mcpServers.mockReset().mockResolvedValue([{ id: 'mcp-1' }])
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

  test('shows missing setup links before recent chats and hides completed steps', async () => {
    mocks.providerStore.providers = [{ id: 'provider-1' }]
    mocks.chatStore.activeAgentId = 'agent-1' as never
    mocks.chatStore.conversations = [{ id: 'chat-1', agentId: 'agent-1', origin: 'chat', updatedAt: 1, title: 'Previous chat' }] as never
    mocks.agentsList.mockResolvedValue([])
    mocks.embeddingConfig.mockResolvedValue({ model: '', providerId: '' })
    mocks.mcpServers.mockResolvedValue([])

    const wrapper = shallowMount(ChatView, { global: { stubs: { Icon: true, RouterLink: { template: '<a><slot /></a>' } } } })
    await vi.waitFor(() => expect(wrapper.findAll('.recent-agent-chat-pill')).toHaveLength(4))

    expect(wrapper.find('.recent-agent-chats').text()).toContain('Create Your First Agent')
    expect(wrapper.findAll('.recent-agent-chat-pill').map(pill => pill.text())).toEqual([
      'Create Your First Agent', 'Setup Memory', 'Install Tools', 'Previous chat',
    ])

    mocks.agentsList.mockResolvedValue([{ id: 'agent-1' }])
    mocks.embeddingConfig.mockResolvedValue({ providerId: 'provider-1', model: 'embed' })
    mocks.mcpServers.mockResolvedValue([{ id: 'mcp-1' }])
    wrapper.unmount()
    const completed = shallowMount(ChatView, { global: { stubs: { Icon: true, RouterLink: { template: '<a><slot /></a>' } } } })
    await vi.waitFor(() => expect(completed.findAll('.recent-agent-chat-pill')).toHaveLength(1))
    expect(completed.find('.recent-agent-chats').text()).toBe('Previous chat')
  })

  test('shows initialising until the server connects, even when providers appear empty', () => {
    mocks.wsConnected.value = false
    const wrapper = shallowMount(ChatView, { global: { stubs: { Icon: true } } })

    expect(wrapper.get('[data-testid="chat-initialising"]').findComponent(ChatPanel).exists()).toBe(true)
    expect(wrapper.find('[data-testid="chat-no-providers"]').exists()).toBe(false)
    expect(wrapper.findComponent(InputBar).exists()).toBe(false)
  })

  test('opens chat search with Ctrl+F when the conversation has searchable content', async () => {
    mocks.providerStore.providers = [{ id: 'provider-1' }]
    mocks.chatStore.messages = [{ role: 'user', content: 'Find this message' }]
    const wrapper = shallowMount(ChatView, { global: { stubs: { Icon: true } } })
    const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, cancelable: true })

    document.dispatchEvent(event)
    await nextTick()

    expect(event.defaultPrevented).toBe(true)
    expect(wrapper.findComponent(ChatPanel).props('searchOpen')).toBe(true)
  })

  test('leaves Ctrl+F to the browser when the conversation has no searchable content', async () => {
    mocks.providerStore.providers = [{ id: 'provider-1' }]
    mocks.chatStore.messages = [{ role: 'system', content: 'Internal context' }]
    const wrapper = shallowMount(ChatView, { global: { stubs: { Icon: true } } })
    const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, cancelable: true })

    document.dispatchEvent(event)
    await nextTick()

    expect(event.defaultPrevented).toBe(false)
    expect(wrapper.findComponent(ChatPanel).props('searchOpen')).toBe(false)
  })
})
