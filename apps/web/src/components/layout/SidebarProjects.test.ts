import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { beforeEach, expect, test, vi } from 'vitest'
import SidebarProjects from './SidebarProjects.vue'

const mocks = vi.hoisted(() => ({
  selectConversation: vi.fn(),
  listConversationsPaginated: vi.fn(),
  listProjectConversations: vi.fn(),
}))
const route = reactive({ name: 'projects' as string, params: {} as Record<string, string> })
const chatStore = reactive({ activeConversationId: null as string | null, activeProjectId: null as string | null, selectConversation: mocks.selectConversation })
const agentStore = reactive({
  liveExecutionConversationIds: [] as string[],
  awaitingHITLConvIds: new Set<string>(),
})
vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('../../api/client', () => ({ api: { chat: {
  listConversationsPaginated: mocks.listConversationsPaginated,
  listProjectConversations: mocks.listProjectConversations,
  onEvent: () => () => {},
  onWaitsChanged: () => () => {},
} } }))
vi.mock('../../stores/chat.store', () => ({ useChatStore: () => chatStore }))
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
  openProjectPage()
  chatStore.activeProjectId = null
  mocks.listConversationsPaginated.mockResolvedValue({
    items: [{ id: 'chat', title: 'Background chat', origin: 'chat' }], total: 1,
  })
  mocks.listProjectConversations.mockResolvedValue([])
})

function openProjectPage(): void {
  route.name = 'project-detail'
  route.params = { id: 'project' }
}

function leaveProject(): void {
  route.name = 'projects'
  route.params = {}
}

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

test('shows an hourglass on a waiting chat until it runs again', async () => {
  mocks.listConversationsPaginated.mockResolvedValue({
    items: [{ id: 'chat', title: 'Background chat', origin: 'chat', wait_until: Date.now() + 5 * 60_000 }], total: 1,
  })
  const wrapper = await render()
  try {
    expect(wrapper.find('ul [icon="lucide:hourglass"]').exists()).toBe(true)
    await wrapper.setProps({ activeConversationIds: ['chat'] })
    expect(wrapper.find('ul [icon="lucide:hourglass"]').exists()).toBe(false)
    expect(wrapper.find('ul').find(spinner).exists()).toBe(true)
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
  leaveProject()
  const wrapper = await render({ activeConversationIds: ['chat'] })
  try {
    expect(wrapper.find(projectSpinner).exists()).toBe(true)
    expect(wrapper.find('project-icon-stub').exists()).toBe(false)
    expect(wrapper.find('ul').exists()).toBe(false)
    expect(mocks.selectConversation).not.toHaveBeenCalled()
    expect(mocks.listProjectConversations).not.toHaveBeenCalled()

    await wrapper.setProps({ activeConversationIds: [] })
    expect(wrapper.find(projectSpinner).exists()).toBe(false)
  } finally { wrapper.unmount() }
})

test('discovers activity that starts after a project was mounted collapsed', async () => {
  leaveProject()
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
  leaveProject()
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
  leaveProject()
  const recentChats = Array.from({ length: 5 }, (_, index) => ({ id: `recent-${index}`, title: 'Recent chat' }))
  mocks.listConversationsPaginated.mockResolvedValue({ items: recentChats, total: 7 })
  mocks.listProjectConversations.mockResolvedValue([...recentChats, { id: 'older-chat' }, { id: 'other-chat' }])
  const wrapper = await render({ activeConversationIds: ['older-chat', 'other-chat'] })
  try {
    expect(wrapper.find(projectSpinner).exists()).toBe(true)
    expect(mocks.listProjectConversations).toHaveBeenCalledWith('project')

    openProjectPage()
    await flushPromises()
    expect(wrapper.findAll('li')).toHaveLength(6)
    expect(wrapper.find(projectSpinner).exists()).toBe(false)
    expect(wrapper.find('project-icon-stub').exists()).toBe(true)

    leaveProject()
    await flushPromises()
    expect(wrapper.find('ul').exists()).toBe(false)
    expect(wrapper.find(projectSpinner).exists()).toBe(true)

    await wrapper.setProps({ activeConversationIds: ['other-chat'] })
    expect(wrapper.find(projectSpinner).exists()).toBe(true)
    await wrapper.setProps({ activeConversationIds: [] })
    expect(wrapper.find(projectSpinner).exists()).toBe(false)
  } finally { wrapper.unmount() }
})

test('expands only while the project page or one of its chats is open', async () => {
  leaveProject()
  const wrapper = await render()
  try {
    expect(wrapper.find('ul').exists()).toBe(false)
    expect(mocks.listConversationsPaginated).not.toHaveBeenCalled()

    openProjectPage()
    await flushPromises()
    expect(wrapper.find('ul').text()).toContain('Background chat')
    expect(wrapper.find('a').attributes('aria-current')).toBe('page')

    route.name = 'conversation'
    route.params = { conversationId: 'chat' }
    chatStore.activeProjectId = 'project'
    await flushPromises()
    expect(wrapper.find('ul').exists()).toBe(true)

    chatStore.activeProjectId = 'other-project'
    await flushPromises()
    expect(wrapper.find('ul').exists()).toBe(false)
  } finally { wrapper.unmount() }
})

test('allows navigation to the project overview from a conversation in that project', async () => {
  route.name = 'conversation'
  route.params = { conversationId: 'chat' }
  chatStore.activeProjectId = 'project'
  const wrapper = await render()
  try {
    const link = wrapper.get('a')
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    link.element.dispatchEvent(click)
    await flushPromises()

    // RouterLink can navigate only if the capture handler leaves the click unhandled.
    expect(click.defaultPrevented).toBe(false)
    expect(link.attributes('aria-expanded')).toBe('true')
    expect(link.attributes('aria-current')).toBeUndefined()
  } finally { wrapper.unmount() }
})

test('toggles the project chat list when already on its overview', async () => {
  const wrapper = await render()
  try {
    const link = wrapper.get('a')
    expect(link.attributes('aria-expanded')).toBe('true')

    const collapse = new MouseEvent('click', { bubbles: true, cancelable: true })
    link.element.dispatchEvent(collapse)
    await flushPromises()
    expect(collapse.defaultPrevented).toBe(true)
    expect(link.attributes('aria-expanded')).toBe('false')

    const expand = new MouseEvent('click', { bubbles: true, cancelable: true })
    link.element.dispatchEvent(expand)
    await flushPromises()
    expect(expand.defaultPrevented).toBe(true)
    expect(link.attributes('aria-expanded')).toBe('true')
  } finally { wrapper.unmount() }
})
