import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AgentDefinition } from '../api/types'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { useAgentStore } from '../stores/agent-runtime.store'
import AgentDetailView from './AgentDetailView.vue'

const mocks = vi.hoisted(() => ({ listFolders: vi.fn() }))

vi.mock('../api/client', () => ({ api: { memoryFolders: { list: mocks.listFolders } } }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'parent' } }),
  useRouter: () => ({ push: vi.fn() }),
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
})
