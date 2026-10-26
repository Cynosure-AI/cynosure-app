import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, test, vi } from 'vitest'
import SidebarAgents from './SidebarAgents.vue'
import { useAgentDefinitionsStore, type AgentDefinition } from '../../stores/agent-definitions.store'
import type { ConversationRow } from '../../api/client'

const mocks = vi.hoisted(() => ({
  update: vi.fn(), push: vi.fn(), setActiveAgent: vi.fn(), startNewChat: vi.fn(),
  selectConversation: vi.fn(), listConversationsPaginated: vi.fn(),
  awaitingHITLConvIds: new Set<string>(),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ name: 'conversation', fullPath: '/chat/current' }),
  useRouter: () => ({ push: mocks.push }),
}))
vi.mock('../../api/http', () => ({ wsConnected: { value: true } }))
vi.mock('../../api/client', () => ({ api: {
  agents: { update: mocks.update },
  chat: {
    listConversationsPaginated: mocks.listConversationsPaginated,
    onEvent: () => () => {}, onChannelConversationState: () => () => {}, onWaitsChanged: () => () => {},
  },
  agent: { onHITLRequest: () => () => {} },
} }))
vi.mock('../../stores/chat.store', () => ({ useChatStore: () => ({
  activeConversationId: null, activeAgentId: null, activeConversationIsStreaming: false,
  setActiveAgent: mocks.setActiveAgent, startNewChat: mocks.startNewChat,
  selectConversation: mocks.selectConversation,
}) }))
vi.mock('../../stores/agent-runtime.store', () => ({ useAgentStore: () => ({
  liveExecutionConversationIds: [], awaitingHITLConvIds: mocks.awaitingHITLConvIds,
}) }))
vi.mock('../../stores/provider.store', () => ({ useProviderStore: () => ({}) }))
vi.mock('../../stores/cyno.store', () => ({ useCynoStore: () => ({
  name: 'Cyno', profile: {}, iconUrl: null, avatar: null,
}) }))

const agent: AgentDefinition = {
  id: 'agent', name: 'Zeta', internalName: 'zeta', description: '', category: '',
  iconUrl: null, imageUrl: null, avatar: null, avatarSource: 'generated', providerId: '', model: '',
  systemPrompt: '', tools: [], subAgents: [], memoryFolders: [], autoApproveTools: false,
  autoToolRouting: false, autoMemory: false, dreamingEnabled: true, autoRouterProviderId: '',
  autoRouterModel: '', generateTitle: true, thinkingEnabled: true, reasoningEffort: 'medium',
  maxContextTokens: null, sortOrder: 0, favorite: false, createdAt: 1, updatedAt: 1,
}

beforeEach(() => {
  mocks.awaitingHITLConvIds.clear()
  mocks.listConversationsPaginated.mockResolvedValue({ items: [], total: 0 })
  setActivePinia(createPinia())
  const store = useAgentDefinitionsStore()
  store.loaded = true
  store.agents = [{ ...agent }]
  mocks.update.mockImplementation(async (id, changes) => ({ ...store.get(id), ...changes }))
})

async function render(collapsed = false) {
  const wrapper = mount(SidebarAgents, { attachTo: document.body, props: { collapsed }, global: {
    stubs: { AgentAvatar: true, HoverTooltip: { template: '<div><slot /></div>' } },
  } })
  await flushPromises()
  return wrapper
}

const menu = () => document.querySelector<HTMLElement>('[role="menu"]')
const action = (label: string) => [...menu()!.querySelectorAll<HTMLButtonElement>('button')]
  .find((button) => button.textContent?.trim() === label)!

const chat: ConversationRow = {
  id: 'approval-chat', title: 'Needs approval', agent_id: 'agent', ma_workspace_id: null,
  origin: 'chat', pinned: 0, last_read_at: null, created_at: 1, updated_at: 2, last_user_message: null,
}

test.each([
  [false, 'polled', 'agent', 'Zeta'],
  [true, 'live', 'agent', 'Zeta'],
  [false, 'live', null, 'Cyno'],
  [true, 'polled', null, 'Cyno'],
] as const)('opens a folded agent approval chat (collapsed: %s, source: %s, agent: %s)', async (collapsed, source, agentId, name) => {
  mocks.listConversationsPaginated.mockResolvedValue({ items: [
    { ...chat, id: 'unrelated-approval', agent_id: 'other-agent', updated_at: 4 },
    { ...chat, id: 'newer-chat', agent_id: agentId, updated_at: 3 },
    { ...chat, agent_id: agentId },
  ], total: 3 })
  if (source === 'live') mocks.awaitingHITLConvIds.add(chat.id)
  const wrapper = await render(collapsed)
  try {
    await wrapper.setProps({ awaitingConversationIds: source === 'polled'
      ? ['unrelated-approval', chat.id] : ['unrelated-approval'] })
    await wrapper.get(`.agent-row[aria-label="${name}"]`).trigger('click')
    await flushPromises()

    expect(mocks.selectConversation).toHaveBeenCalledWith(chat.id, agentId)
    expect(mocks.push).toHaveBeenCalledWith({ name: 'conversation', params: { conversationId: chat.id } })
    expect(mocks.startNewChat).not.toHaveBeenCalled()
    expect(wrapper.find('ul').exists()).toBe(!collapsed)
  } finally { wrapper.unmount() }
})

test.each([false, true])('starts a new chat when the agent has no pending approval (collapsed: %s)', async (collapsed) => {
  mocks.listConversationsPaginated.mockResolvedValue({ items: [chat], total: 1 })
  const wrapper = await render(collapsed)
  try {
    await wrapper.get('.agent-row[aria-label="Zeta"]').trigger('click')
    await flushPromises()
    expect(mocks.setActiveAgent).toHaveBeenCalledWith('agent')
    expect(mocks.startNewChat).toHaveBeenCalledOnce()
    expect(mocks.selectConversation).not.toHaveBeenCalled()
    expect(mocks.push).toHaveBeenCalledWith({ name: 'triggers-chat' })
  } finally { wrapper.unmount() }
})

test('the explicit New chat button starts a fresh chat even with pending approval', async () => {
  mocks.listConversationsPaginated.mockResolvedValue({ items: [chat], total: 1 })
  mocks.awaitingHITLConvIds.add(chat.id)
  const wrapper = await render()
  try {
    await wrapper.get('[aria-label="New chat with Zeta"]').trigger('click')
    await flushPromises()
    expect(mocks.startNewChat).toHaveBeenCalledOnce()
    expect(mocks.selectConversation).not.toHaveBeenCalled()
  } finally { wrapper.unmount() }
})

test.each([false, true])('favorites and unfavorites from the context menu (collapsed: %s)', async (collapsed) => {
  const wrapper = await render(collapsed)
  await wrapper.get('.agent-row[aria-label="Zeta"]').trigger('contextmenu', { clientX: 50, clientY: 200 })
  expect(menu()?.getAttribute('aria-label')).toBe('Zeta options')
  expect(document.activeElement).toBe(action('Favorite'))
  expect(mocks.setActiveAgent).not.toHaveBeenCalled()
  expect(mocks.startNewChat).not.toHaveBeenCalled()

  action('Favorite').click()
  await flushPromises()
  expect(mocks.update).toHaveBeenLastCalledWith('agent', { favorite: true })
  expect(useAgentDefinitionsStore().get('agent')?.favorite).toBe(true)
  expect(wrapper.findAll('.agent-row')[0].attributes('aria-label')).toBe('Zeta')
  expect(menu()).toBeNull()

  await wrapper.get('.agent-row[aria-label="Zeta"]').trigger('contextmenu')
  action('Unfavorite').click()
  await flushPromises()
  expect(mocks.update).toHaveBeenLastCalledWith('agent', { favorite: false })
  expect(useAgentDefinitionsStore().get('agent')?.favorite).toBe(false)
})

test.each([false, true])('opens the agent editor without starting a chat (collapsed: %s)', async (collapsed) => {
  const wrapper = await render(collapsed)
  await wrapper.get('.agent-row[aria-label="Zeta"]').trigger('contextmenu')
  action('Edit').click()
  await flushPromises()

  expect(mocks.push).toHaveBeenCalledWith({ name: 'agent-detail', params: { id: 'agent' }, query: { returnTo: '/chat/current' } })
  expect(mocks.startNewChat).not.toHaveBeenCalled()
  expect(menu()).toBeNull()
})

test('offers Edit for Cyno and opens its profile editor', async () => {
  const wrapper = await render()
  await wrapper.get('.agent-row[aria-label="Cyno"]').trigger('contextmenu')
  expect(menu()?.textContent?.trim()).toBe('Edit')
  action('Edit').click()
  await flushPromises()
  expect(mocks.push).toHaveBeenCalledWith({ name: 'cyno', query: { returnTo: '/chat/current' } })
  expect(mocks.update).not.toHaveBeenCalled()
})

test('supports Shift+F10 and closes on Escape, outside click, scroll, or resize', async () => {
  const wrapper = await render()
  const row = wrapper.get('.agent-row[aria-label="Zeta"]')
  await row.trigger('keydown', { key: 'F10', shiftKey: true })
  expect(menu()).not.toBeNull()
  action('Favorite').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await flushPromises()
  expect(menu()).toBeNull()

  for (const event of ['click', 'scroll', 'resize']) {
    await row.trigger('contextmenu')
    expect(menu()).not.toBeNull()
    if (event === 'resize') window.dispatchEvent(new Event(event))
    else document.body.dispatchEvent(new Event(event, { bubbles: true }))
    await flushPromises()
    expect(menu()).toBeNull()
  }
})
