import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AgentDefinition } from '../api/types'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { useAgentStore } from '../stores/agent-runtime.store'
import AgentDetailView from './AgentDetailView.vue'

const mocks = vi.hoisted(() => ({
  listFolders: vi.fn(),
  push: vi.fn(),
  route: { params: { id: 'parent' }, query: {} as Record<string, string> },
}))

vi.mock('../api/client', () => ({ api: { memoryFolders: { list: mocks.listFolders } } }))
vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  useRouter: () => ({
    push: mocks.push,
    resolve: (path: string) => ({ name: /^\/chat\/[^/]+$/.test(path) ? 'conversation' : path === '/chat' ? 'triggers-chat' : 'not-found' }),
  }),
}))
vi.mock('../stores/chat.store', () => ({ useChatStore: () => ({ setActiveAgent: vi.fn() }) }))

function agent(assignments: Partial<AgentDefinition>): AgentDefinition {
  return {
    id: 'parent', name: 'Parent', description: '', tools: [], memoryFolders: [], subAgents: [],
    ...assignments,
  } as AgentDefinition
}

describe('AgentDetailView category warnings', () => {
  beforeEach(() => {
    mocks.listFolders.mockReset().mockResolvedValue([{ id: 'existing-folder' }])
    mocks.push.mockReset()
    mocks.route.query = {}
  })

  test('shows a warning on each affected category and clears it when assignments are fixed', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const definitions = useAgentDefinitionsStore()
    definitions.agents = [agent({
      tools: ['missing-tool'], memoryFolders: ['missing-folder'],
      subAgents: [{ agentId: 'missing-agent' }],
    })]
    definitions.load = vi.fn().mockResolvedValue(undefined)
    useAgentStore().availableTools = []

    const wrapper = mount(AgentDetailView, {
      global: {
        plugins: [pinia],
        stubs: {
          Icon: true, AgentGeneralTab: true, AgentToolsTab: true, AgentMemoryTab: true,
          AgentSubAgentsTab: true, AgentAdvancedTab: true,
        },
      },
    })
    await flushPromises()

    const tabs = wrapper.findAll('[role="tab"]')
    expect(tabs).toHaveLength(5)
    expect(tabs[0].find('[icon="lucide:alert-triangle"]').exists()).toBe(false)
    expect(tabs[1].get('[icon="lucide:alert-triangle"]').attributes('title')).toBe('Unavailable tools: missing-tool')
    expect(tabs[2].get('[icon="lucide:alert-triangle"]').attributes('title')).toBe('Unavailable memory folders: missing-folder')
    expect(tabs[3].get('[icon="lucide:alert-triangle"]').attributes('title')).toBe('Unavailable sub-agents: missing-agent')
    expect(tabs[4].find('[icon="lucide:alert-triangle"]').exists()).toBe(false)

    definitions.agents = [agent({})]
    await nextTick()
    expect(wrapper.findAll('[role="tab"] [icon="lucide:alert-triangle"]')).toHaveLength(0)
  })

  test('returns to the originating conversation from the agent settings', async () => {
    mocks.route.query = { returnTo: '/chat/conversation-1' }
    const pinia = createPinia()
    setActivePinia(pinia)
    const definitions = useAgentDefinitionsStore()
    definitions.agents = [agent({})]
    definitions.load = vi.fn().mockResolvedValue(undefined)

    const wrapper = mount(AgentDetailView, {
      global: {
        plugins: [pinia],
        stubs: {
          Icon: true, AgentGeneralTab: true, AgentToolsTab: true, AgentMemoryTab: true,
          AgentSubAgentsTab: true, AgentAdvancedTab: true,
        },
      },
    })
    await flushPromises()

    await wrapper.get('[aria-label="Back to chat"]').trigger('click')
    expect(mocks.push).toHaveBeenCalledWith('/chat/conversation-1')
  })
})
