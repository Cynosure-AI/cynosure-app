import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CommandPalette from './CommandPalette.vue'
import { useCommandPalette } from '../../composables/useCommandPalette'

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  selectConversation: vi.fn(),
  listConversationsPaginated: vi.fn(),
  listCronJobs: vi.fn(),
  loadServers: vi.fn(),
  startProjectChat: vi.fn(),
}))

const mcpServers = ref([
  { id: 'mcp-1', name: 'GitHub', originalName: 'github', description: 'Repos and issues', enabled: true, connected: true, toolCount: 12 },
])

vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('../../api/client', () => ({
  api: {
    chat: { listConversationsPaginated: mocks.listConversationsPaginated },
    cronJobs: { list: mocks.listCronJobs },
  },
}))
vi.mock('../../stores/chat.store', () => ({
  useChatStore: () => ({ selectConversation: mocks.selectConversation }),
}))
vi.mock('../../stores/agent-definitions.store', () => {
  const agents = [
    { id: 'agent-1', name: 'Research Assistant', description: 'Finds papers', category: 'Research', iconUrl: null },
    { id: 'agent-2', name: 'Chef', description: 'Recipes', category: 'Food', iconUrl: null },
  ]
  return {
    useAgentDefinitionsStore: () => ({
      agents,
      loaded: true,
      load: vi.fn(),
      get: (id: string) => agents.find((agent) => agent.id === id),
    }),
  }
})
vi.mock('../../stores/projects.store', () => {
  const projects = [
    { id: 'project-1', name: 'Garden Planner', description: 'Spring beds', archived: false, defaultAgentId: null, conversationCount: 2, openTaskCount: 1 },
  ]
  return {
    useProjectsStore: () => ({
      projects,
      activeProjects: projects,
      load: vi.fn().mockResolvedValue(undefined),
      get: (id: string | null) => projects.find((project) => project.id === id),
    }),
  }
})
vi.mock('../../composables/useProjectChat', () => ({
  useProjectChat: () => ({ startProjectChat: mocks.startProjectChat }),
}))
vi.mock('../../composables/useMcpServers', () => ({
  useMcpServers: () => ({ servers: mcpServers, loadServers: mocks.loadServers }),
}))

function conversationRow(id: string, title: string, agentId: string | null = null) {
  return { id, title, agent_id: agentId, ma_workspace_id: null, origin: 'chat', pinned: 0, last_read_at: null, created_at: 0, updated_at: Date.now() }
}

async function openPalette() {
  const wrapper = mount(CommandPalette, { attachTo: document.body, global: { stubs: { Icon: true } } })
  useCommandPalette().open()
  await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')).not.toBeNull())
  const input = () => document.body.querySelector<HTMLInputElement>('input[role="combobox"]')!
  const text = () => document.body.querySelector('[role="dialog"]')?.textContent ?? ''
  return { wrapper, input, text }
}

function keydown(target: Element, key: string, init: KeyboardEventInit = {}) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
}

describe('CommandPalette', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useCommandPalette().close()
    mocks.listConversationsPaginated.mockResolvedValue({ items: [conversationRow('c-1', 'Trip planning', 'agent-1')], total: 1 })
    mocks.listCronJobs.mockResolvedValue([
      { id: 'cron-1', name: 'Morning digest', agentId: 'agent-1', agentName: 'Research Assistant', schedule: '0 9 * * *', prompt: 'Summarize', enabled: true, isRunning: false },
    ])
    mocks.loadServers.mockResolvedValue(undefined)
  })

  it('lists chats, agents, MCP servers and schedules when opened', async () => {
    const { wrapper, text } = await openPalette()
    await vi.waitFor(() => expect(text()).toContain('Morning digest'))
    expect(text()).toContain('Trip planning')
    expect(text()).toContain('Research Assistant')
    expect(text()).toContain('GitHub')
    expect(mocks.listConversationsPaginated).toHaveBeenCalledWith(5, 0, 'updated', undefined)
    wrapper.unmount()
  })

  it('filters local entities and searches conversations on the server', async () => {
    const { wrapper, input, text } = await openPalette()
    await vi.waitFor(() => expect(text()).toContain('Morning digest'))
    mocks.listConversationsPaginated.mockResolvedValue({ items: [], total: 0 })

    input().value = 'chef'
    input().dispatchEvent(new Event('input'))
    await vi.waitFor(() => expect(mocks.listConversationsPaginated).toHaveBeenLastCalledWith(5, 0, 'updated', 'chef'))
    await vi.waitFor(() => expect(text()).not.toContain('Trip planning'))
    expect(text()).toContain('Chef')
    expect(text()).not.toContain('Research Assistant')
    expect(text()).not.toContain('GitHub')
    wrapper.unmount()
  })

  it('opens the highlighted result with the keyboard and closes', async () => {
    const { wrapper, input, text } = await openPalette()
    await vi.waitFor(() => expect(text()).toContain('Morning digest'))

    // First row is the conversation, then the project, then the first agent.
    keydown(input(), 'ArrowDown')
    keydown(input(), 'ArrowDown')
    keydown(input(), 'Enter')
    await vi.waitFor(() => expect(mocks.push).toHaveBeenCalledWith({ name: 'agent-detail', params: { id: 'agent-1' } }))
    expect(useCommandPalette().commandPaletteOpen.value).toBe(false)
    wrapper.unmount()
  })

  it('selects the conversation before navigating to it', async () => {
    const { wrapper, input, text } = await openPalette()
    await vi.waitFor(() => expect(text()).toContain('Trip planning'))

    keydown(input(), 'Enter')
    await vi.waitFor(() => expect(mocks.push).toHaveBeenCalledWith({ name: 'conversation', params: { conversationId: 'c-1' } }))
    expect(mocks.selectConversation).toHaveBeenCalledWith('c-1', 'agent-1')
    wrapper.unmount()
  })

  it('cycles the scope with Tab and links MCP servers to the filtered settings page', async () => {
    const { wrapper, input, text } = await openPalette()
    await vi.waitFor(() => expect(text()).toContain('GitHub'))

    keydown(input(), 'Tab')
    keydown(input(), 'Tab')
    keydown(input(), 'Tab')
    keydown(input(), 'Tab')
    await vi.waitFor(() => expect(text()).not.toContain('Morning digest'))
    expect(text()).not.toContain('Research Assistant')

    keydown(input(), 'Enter')
    await vi.waitFor(() => expect(mocks.push).toHaveBeenCalledWith({ name: 'settings-mcp', query: { filter: 'GitHub' } }))
    wrapper.unmount()
  })

  it('finds projects and offers a new chat in the best match', async () => {
    const { wrapper, input, text } = await openPalette()
    await vi.waitFor(() => expect(text()).toContain('Garden Planner'))
    mocks.listConversationsPaginated.mockResolvedValue({ items: [], total: 0 })

    input().value = 'garden'
    input().dispatchEvent(new Event('input'))
    await vi.waitFor(() => expect(text()).not.toContain('Trip planning'))
    expect(text()).toContain('New chat in Garden Planner')
    expect(text()).not.toContain('Research Assistant')

    keydown(input(), 'ArrowDown')
    keydown(input(), 'Enter')
    await vi.waitFor(() => expect(mocks.startProjectChat).toHaveBeenCalledWith(expect.objectContaining({ id: 'project-1' })))
    wrapper.unmount()
  })

  it('closes on Escape without letting the event reach other dialogs', async () => {
    const { wrapper, input } = await openPalette()
    const documentListener = vi.fn()
    document.addEventListener('keydown', documentListener)

    keydown(input(), 'Escape')
    expect(useCommandPalette().commandPaletteOpen.value).toBe(false)
    expect(documentListener).not.toHaveBeenCalled()
    document.removeEventListener('keydown', documentListener)
    wrapper.unmount()
  })
})
