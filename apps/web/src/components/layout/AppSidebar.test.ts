import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { beforeEach, expect, test, vi } from 'vitest'
import AppSidebar from './AppSidebar.vue'
import GlobalRecentChats from './GlobalRecentChats.vue'
import SidebarAgents from './SidebarAgents.vue'
import { usePreferencesStore } from '../../stores/preferences.store'
import { SK_SIDEBAR_CHAT_VIEW } from '../../utils/storage-keys'

const collapsed = ref(false)
vi.mock('../../composables/useSidebar', () => ({ useSidebar: () => ({
  sidebarCollapsed: collapsed, close: vi.fn(), toggleCollapse: vi.fn(),
}) }))
vi.mock('@vueuse/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@vueuse/core')>(),
  useMediaQuery: () => ref(true),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/chat' }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('../../api/http', () => ({ wsConnected: ref(true) }))
vi.mock('../../api/client', () => ({ api: {
  instances: { list: async () => [
    { id: 'running', status: 'running', conversationId: 'running-chat' },
    { id: 'awaiting', status: 'awaiting-approval', conversationId: 'awaiting-chat' },
  ] },
  activity: { list: async () => ({ items: [] }) },
  chat: { onEvent: () => () => {} },
  agent: { onHITLRequest: () => () => {} },
  memory: { onDreamUpdated: () => () => {} },
} }))
vi.mock('../../stores/provider.store', () => ({ useProviderStore: () => ({ providers: [] }) }))
vi.mock('../../stores/agent-definitions.store', () => ({ useAgentDefinitionsStore: () => ({}) }))
vi.mock('../../stores/chat.store', () => ({ useChatStore: () => ({}) }))
vi.mock('../../stores/projects.store', () => ({ useProjectsStore: () => ({
  activeProjects: [], ensureLoaded: async () => {},
}) }))
vi.mock('../../stores/memory-jobs.store', () => ({ useMemoryJobsStore: () => ({
  activeJobs: [], hasRunningJobs: false, startPolling: vi.fn(), stopPolling: vi.fn(),
}) }))
vi.mock('../../composables/useAppBranding', () => ({ useAppBranding: () => ({}) }))
vi.mock('../../composables/useCommandPalette', () => ({
  commandPaletteShortcutLabel: 'Ctrl+K', useCommandPalette: () => ({ open: vi.fn() }),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  collapsed.value = false
})

async function render() {
  const wrapper = shallowMount(AppSidebar, { global: {
    renderStubDefaultSlot: true,
    stubs: { RouterLink: { template: '<a><slot /></a>' } },
  } })
  await flushPromises()
  return wrapper
}

test('defaults to global chats and switches views from either section menu', async () => {
  const wrapper = await render()
  const preferences = usePreferencesStore()
  expect(wrapper.findComponent(GlobalRecentChats).exists()).toBe(true)
  expect(wrapper.findComponent(SidebarAgents).exists()).toBe(false)
  expect(wrapper.get('.recent-region .region-toggle').text()).toBe('Chats')

  await wrapper.get('[aria-label="Chats options"]').trigger('click')
  expect(wrapper.get('[role="menuitemradio"][aria-checked="true"]').text()).toBe('Global chats')
  // Filters remain available and carry across both views.
  await wrapper.findAll('[role="menuitemcheckbox"]').find((item) => item.text() === 'Cron')!.trigger('click')
  expect(wrapper.getComponent(GlobalRecentChats).props('filters')).toEqual(['cron'])
  await wrapper.findAll('[role="menuitemradio"]')[1].trigger('click')

  expect(wrapper.findComponent(GlobalRecentChats).exists()).toBe(false)
  expect(wrapper.get('.recent-region .region-toggle').text()).toBe('Agents')
  expect(wrapper.find('[role="menu"]').exists()).toBe(false)
  expect(preferences.sidebarChatView).toBe('agents')
  expect(localStorage.getItem(SK_SIDEBAR_CHAT_VIEW)).toBe('agents')
  expect(wrapper.getComponent(SidebarAgents).props()).toMatchObject({
    filters: ['cron'], excludeProjectChats: true,
    activeConversationIds: ['running-chat'], awaitingConversationIds: ['awaiting-chat'],
  })

  await wrapper.get('[aria-label="Agents options"]').trigger('click')
  expect(wrapper.get('[role="menuitemradio"][aria-checked="true"]').text()).toBe('Agents')
  await wrapper.findAll('[role="menuitemradio"]')[0].trigger('click')
  expect(wrapper.findComponent(SidebarAgents).exists()).toBe(false)
  expect(wrapper.getComponent(GlobalRecentChats).props()).toMatchObject({
    filters: ['cron'], excludeProjectChats: true,
    activeConversationIds: ['running-chat'], awaitingConversationIds: ['awaiting-chat'],
  })
  expect(localStorage.getItem(SK_SIDEBAR_CHAT_VIEW)).toBe('global')
})

test('restores Agents after mounting again', async () => {
  localStorage.setItem(SK_SIDEBAR_CHAT_VIEW, 'agents')
  const wrapper = await render()
  expect(wrapper.findComponent(SidebarAgents).exists()).toBe(true)
  expect(wrapper.get('.recent-region .region-toggle').text()).toBe('Agents')
})

test('keeps agent icons in the collapsed rail and hides the global list', async () => {
  const wrapper = await render()
  collapsed.value = true
  await flushPromises()
  expect(wrapper.find('.recent-region').exists()).toBe(false)

  usePreferencesStore().sidebarChatView = 'agents'
  await flushPromises()
  expect(wrapper.getComponent(SidebarAgents).props('collapsed')).toBe(true)
  expect(wrapper.find('[aria-label="Agents options"]').exists()).toBe(false)
})

test('switching views opens a closed section and Escape dismisses its menu', async () => {
  const wrapper = await render()
  await wrapper.get('.recent-region .region-toggle').trigger('click')
  expect(wrapper.findComponent(GlobalRecentChats).exists()).toBe(false)
  await wrapper.get('[aria-label="Chats options"]').trigger('click')
  await wrapper.findAll('[role="menuitemradio"]')[1].trigger('click')
  expect(wrapper.get('.recent-region .region-toggle').attributes('aria-expanded')).toBe('true')

  await wrapper.get('[aria-label="Agents options"]').trigger('click')
  await wrapper.get('[role="menu"]').trigger('keydown', { key: 'Escape' })
  expect(wrapper.find('[role="menu"]').exists()).toBe(false)
})
