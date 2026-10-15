import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { beforeEach, expect, test, vi } from 'vitest'
import GlobalRecentChats from './GlobalRecentChats.vue'

const mocks = vi.hoisted(() => ({
  listConversationsPaginated: vi.fn(),
  waitsChanged: [] as Array<() => void>,
}))
const agentStore = reactive({
  liveExecutionConversationIds: [] as string[],
  awaitingHITLConvIds: new Set<string>(),
})
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('../../api/http', () => ({ wsConnected: { value: true } }))
vi.mock('../../api/client', () => ({ api: {
  chat: {
    listConversationsPaginated: mocks.listConversationsPaginated,
    onEvent: () => () => {},
    onChannelConversationState: () => () => {},
    onWaitsChanged: (cb: () => void) => { mocks.waitsChanged.push(cb); return () => {} },
  },
  agent: { onHITLRequest: () => () => {} },
} }))
vi.mock('../../stores/chat.store', () => ({ useChatStore: () => ({
  activeConversationId: null, activeProjectId: null, activeConversationIsStreaming: false, conversations: [],
}) }))
vi.mock('../../stores/agent-runtime.store', () => ({ useAgentStore: () => agentStore }))
vi.mock('../../stores/agent-definitions.store', () => ({ useAgentDefinitionsStore: () => ({ get: () => undefined }) }))
vi.mock('../../stores/cyno.store', () => ({ useCynoStore: () => ({ name: 'Cyno' }) }))

const resumesAt = new Date(2026, 9, 14, 14, 32).getTime()
const row = (waitUntil: number | null) => ({
  id: 'chat', title: 'Deploy watch', agent_id: null, origin: 'chat', pinned: 0,
  last_read_at: null, created_at: 1, updated_at: 1, wait_until: waitUntil,
})

beforeEach(() => {
  vi.useRealTimers()
  agentStore.liveExecutionConversationIds = []
  mocks.waitsChanged.length = 0
  mocks.listConversationsPaginated.mockReset()
  mocks.listConversationsPaginated.mockResolvedValue({ items: [row(resumesAt)], total: 1 })
})

async function render() {
  const wrapper = mount(GlobalRecentChats, { global: { stubs: { Icon: true } } })
  await flushPromises()
  return wrapper
}

const hourglass = '[icon="lucide:hourglass"]'

test('marks a waiting chat with its resume time', async () => {
  const wrapper = await render()
  try {
    expect(wrapper.find(hourglass).exists()).toBe(true)
    expect(wrapper.text()).toContain('Resumes at')
  } finally { wrapper.unmount() }
})

test('shows the running spinner instead while the chat is working', async () => {
  agentStore.liveExecutionConversationIds = ['chat']
  const wrapper = await render()
  try {
    expect(wrapper.find(hourglass).exists()).toBe(false)
    expect(wrapper.find('[icon="lucide:loader-circle"]').exists()).toBe(true)
  } finally { wrapper.unmount() }
})

test('clears the indicator when the server reports the wait ended', async () => {
  const wrapper = await render()
  try {
    mocks.listConversationsPaginated.mockResolvedValue({ items: [row(null)], total: 1 })
    vi.useFakeTimers()
    mocks.waitsChanged.forEach((cb) => cb())
    await vi.advanceTimersByTimeAsync(250)
    vi.useRealTimers()
    await flushPromises()
    expect(wrapper.find(hourglass).exists()).toBe(false)
  } finally { wrapper.unmount() }
})
