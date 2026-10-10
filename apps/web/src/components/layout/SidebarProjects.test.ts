import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { beforeEach, expect, test, vi } from 'vitest'
import SidebarProjects from './SidebarProjects.vue'
import { SK_SIDEBAR_EXPANDED_PROJECTS } from '../../utils/storage-keys'

const mocks = vi.hoisted(() => ({
  selectConversation: vi.fn(),
  listConversationsPaginated: vi.fn(),
  listProjectConversations: vi.fn(),
}))
const agentStore = reactive({
  liveExecutionConversationIds: [] as string[],
  awaitingHITLConvIds: new Set<string>(),
})
vi.mock('vue-router', () => ({
  useRoute: () => ({ name: 'projects', params: {} }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('../../api/client', () => ({ api: { chat: {
  listConversationsPaginated: mocks.listConversationsPaginated,
  listProjectConversations: mocks.listProjectConversations,
  onEvent: () => () => {},
} } }))
vi.mock('../../stores/chat.store', () => ({ useChatStore: () => ({
  activeConversationId: null, activeProjectId: null, selectConversation: mocks.selectConversation,
}) }))
vi.mock('../../stores/agent-runtime.store', () => ({ useAgentStore: () => agentStore }))
vi.mock('../../stores/projects.store', () => ({ useProjectsStore: () => ({
  activeProjects: [{ id: 'project', name: 'Project', updatedAt: 1 }],
  ensureLoaded: () => Promise.resolve(),
}) }))
vi.mock('../../composables/useProjectChat', () => ({
  useProjectChat: () => ({ startProjectChat: vi.fn() }),
}))

beforeEach(() => {
  agentStore.liveExecutionConversationIds = []
  agentStore.awaitingHITLConvIds = new Set()
  localStorage.setItem(SK_SIDEBAR_EXPANDED_PROJECTS, JSON.stringify(['project']))
  mocks.listConversationsPaginated.mockResolvedValue({
    items: [{ id: 'chat', title: 'Background chat', origin: 'chat' }], total: 1,
  })
  mocks.listProjectConversations.mockResolvedValue([])
})

async function render(props: { activeConversationIds?: string[]; awaitingConversationIds?: string[] } = {}) {
  const wrapper = mount(SidebarProjects, { props, global: { stubs: {
    RouterLink: { template: '<a><slot /></a>' }, ProjectIcon: true, Icon: true,
  } } })
  await flushPromises()
  return wrapper
}

const spinner = '[icon="lucide:loader-circle"]'
const projectSpinner = '[aria-label="A chat in this project is running"]'
const projectApproval = '[aria-label="A chat in this project is waiting for your approval"]'

test('shows and clears polled running status without opening the chat', async () => {
  const wrapper = await render()
  try {
    expect(wrapper.find(spinner).exists()).toBe(false)
    await wrapper.setProps({ activeConversationIds: ['chat'] })
    expect(wrapper.find(spinner).exists()).toBe(true)
    expect(wrapper.find('ul').find(spinner).exists()).toBe(true)
    expect(wrapper.find(projectSpinner).exists()).toBe(false)
    expect(mocks.selectConversation).not.toHaveBeenCalled()
    await wrapper.setProps({ activeConversationIds: [] })
    expect(wrapper.find(spinner).exists()).toBe(false)
  } finally { wrapper.unmount() }
})

test('preserves live execution status and prioritizes approval indicators', async () => {
  agentStore.liveExecutionConversationIds = ['chat']
  const wrapper = await render()
  try {
    expect(wrapper.find(spinner).exists()).toBe(true)
    await wrapper.setProps({ awaitingConversationIds: ['chat'] })
    expect(wrapper.find(spinner).exists()).toBe(false)
    expect(wrapper.find('[aria-label="Waiting for your approval"]').exists()).toBe(true)
  } finally { wrapper.unmount() }
})

test('shows existing activity on a collapsed project without expanding or selecting a chat', async () => {
  localStorage.setItem(SK_SIDEBAR_EXPANDED_PROJECTS, '[]')
  const wrapper = await render({ activeConversationIds: ['chat'] })
  try {
    expect(wrapper.find(projectSpinner).exists()).toBe(true)
    expect(wrapper.find('ul').exists()).toBe(false)
    expect(wrapper.find('a').attributes('aria-expanded')).toBe('false')
    expect(mocks.selectConversation).not.toHaveBeenCalled()
    expect(mocks.listProjectConversations).not.toHaveBeenCalled()

    await wrapper.setProps({ activeConversationIds: [] })
    expect(wrapper.find(projectSpinner).exists()).toBe(false)
  } finally { wrapper.unmount() }
})

test('discovers activity that starts after a project was mounted collapsed', async () => {
  localStorage.setItem(SK_SIDEBAR_EXPANDED_PROJECTS, '[]')
  const wrapper = await render()
  try {
    expect(mocks.listConversationsPaginated).not.toHaveBeenCalled()
    agentStore.liveExecutionConversationIds = ['chat']
    await flushPromises()
    expect(wrapper.find(projectSpinner).exists()).toBe(true)

    agentStore.liveExecutionConversationIds = []
    await flushPromises()
    expect(wrapper.find(projectSpinner).exists()).toBe(false)
  } finally { wrapper.unmount() }
})

test('keeps approval visible over running activity on a collapsed project', async () => {
  localStorage.setItem(SK_SIDEBAR_EXPANDED_PROJECTS, '[]')
  const wrapper = await render({ activeConversationIds: ['chat'], awaitingConversationIds: ['chat'] })
  try {
    expect(wrapper.find(projectApproval).exists()).toBe(true)
    expect(wrapper.find(projectSpinner).exists()).toBe(false)
    await wrapper.setProps({ awaitingConversationIds: [] })
    expect(wrapper.find(projectApproval).exists()).toBe(false)
    expect(wrapper.find(projectSpinner).exists()).toBe(true)
  } finally { wrapper.unmount() }
})

test('finds running chats outside the recent list and shows project status only while collapsed', async () => {
  localStorage.setItem(SK_SIDEBAR_EXPANDED_PROJECTS, '[]')
  const recentChats = Array.from({ length: 5 }, (_, index) => ({ id: `recent-${index}`, title: 'Recent chat' }))
  mocks.listConversationsPaginated.mockResolvedValue({ items: recentChats, total: 7 })
  mocks.listProjectConversations.mockResolvedValue([...recentChats, { id: 'older-chat' }, { id: 'other-chat' }])
  const wrapper = await render({ activeConversationIds: ['older-chat', 'other-chat'] })
  try {
    expect(wrapper.find(projectSpinner).exists()).toBe(true)
    expect(mocks.listProjectConversations).toHaveBeenCalledWith('project')

    await wrapper.find('a').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('li')).toHaveLength(6)
    expect(wrapper.find(projectSpinner).exists()).toBe(false)

    await wrapper.find('a').trigger('click')
    expect(wrapper.find('ul').exists()).toBe(false)
    expect(wrapper.find(projectSpinner).exists()).toBe(true)

    await wrapper.setProps({ activeConversationIds: ['other-chat'] })
    expect(wrapper.find(projectSpinner).exists()).toBe(true)
    await wrapper.setProps({ activeConversationIds: [] })
    expect(wrapper.find(projectSpinner).exists()).toBe(false)
  } finally { wrapper.unmount() }
})
