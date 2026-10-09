import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { beforeEach, expect, test, vi } from 'vitest'
import SidebarProjects from './SidebarProjects.vue'
import { SK_SIDEBAR_EXPANDED_PROJECTS } from '../../utils/storage-keys'

const mocks = vi.hoisted(() => ({
  selectConversation: vi.fn(),
  listConversationsPaginated: vi.fn(),
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
})

async function render() {
  const wrapper = mount(SidebarProjects, { global: { stubs: {
    RouterLink: { template: '<a><slot /></a>' }, ProjectIcon: true, Icon: true,
  } } })
  await flushPromises()
  return wrapper
}

const spinner = '[icon="lucide:loader-circle"]'

test('shows and clears polled running status without opening the chat', async () => {
  const wrapper = await render()
  try {
    expect(wrapper.find(spinner).exists()).toBe(false)
    await wrapper.setProps({ activeConversationIds: ['chat'] })
    expect(wrapper.find(spinner).exists()).toBe(true)
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
