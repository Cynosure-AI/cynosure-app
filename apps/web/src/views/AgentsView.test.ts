import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AgentDefinition } from '../api/types'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { useAgentStore } from '../stores/agent-runtime.store'
import AgentsView from './AgentsView.vue'

const mocks = vi.hoisted(() => ({
  listFolders: vi.fn(),
}))

vi.mock('../api/client', () => ({
  api: { memoryFolders: { list: mocks.listFolders } },
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('../composables/useMcpServers', () => ({
  useMcpServers: () => ({ servers: ref([]), loadServers: vi.fn().mockResolvedValue(undefined) }),
}))
vi.mock('../composables/useProviderLogos', () => ({
  useProviderLogos: () => ({ logoUrl: () => null }),
}))

const NameColumnTable = {
  name: 'DataTable',
  props: { items: { type: Array, default: () => [] }, columns: { type: Array, default: () => [] } },
  template: '<div><div v-for="item in items" :key="item.id"><slot name="col-name" :item="item" /><slot name="col-state" :item="item" /></div></div>',
}

function agent(id: string, assignments: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id, name: id, description: '', tools: [], subAgents: [], memoryFolders: [],
    ...assignments,
  } as AgentDefinition
}

describe('AgentsView assignment warnings', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.listFolders.mockReset().mockResolvedValue([{ id: 'existing-folder' }])
  })

  test('identifies missing tools, memory folders, and sub-agents', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const definitions = useAgentDefinitionsStore()
    definitions.agents = [
      agent('ready', { memoryFolders: ['existing-folder'] }),
      agent('missing-tool', { tools: ['removed-tool'] }),
      agent('missing-folder', { memoryFolders: ['removed-folder'] }),
      agent('missing-agent', { subAgents: [{ agentId: 'removed-agent' }] }),
    ]
    definitions.load = vi.fn().mockResolvedValue(undefined)
    useAgentStore().availableTools = []

    const wrapper = mount(AgentsView, {
      global: {
        plugins: [pinia],
        stubs: { DataTable: NameColumnTable, Icon: true, BaseCard: true, HoverTooltip: true, ModalDialog: true, ProviderModelSelect: true },
      },
    })
    await flushPromises()

    const warnings = wrapper.findAll('[role="img"][aria-label^="Needs attention:"]')
      .map(icon => icon.attributes('aria-label'))
    expect(warnings).toHaveLength(3)
    expect(warnings).toEqual(expect.arrayContaining([
      'Needs attention: Tool: removed-tool',
      'Needs attention: Memory folder: removed-folder',
      'Needs attention: Sub-agent: removed-agent',
    ]))
    expect(wrapper.find('[aria-label^="Unavailable assignments:"]').exists()).toBe(false)

    const table = wrapper.getComponent({ name: 'DataTable' })
    const columns = table.props('columns') as Array<{ key: string; sortable?: boolean; sortValue?: (item: AgentDefinition) => number }>
    expect(columns.at(-1)?.key).toBe('state')
    const stateColumn = columns
      .find(column => column.key === 'state')
    expect(stateColumn?.sortable).toBe(true)
    expect(stateColumn?.sortValue?.(definitions.agents[0])).toBe(0)
    expect(stateColumn?.sortValue?.(definitions.agents[1])).toBe(1)
    expect(wrapper.findAll('[role="img"][aria-label="Ready"]')).toHaveLength(1)
    expect(wrapper.findAll('[role="img"][aria-label^="Needs attention:"]')).toHaveLength(3)

    const filter = wrapper.get('select[aria-label="Filter agents by state"]')
    await filter.setValue('warning')
    expect((table.props('items') as AgentDefinition[]).map(item => item.id)).toEqual([
      'missing-agent', 'missing-folder', 'missing-tool',
    ])
    await filter.setValue('ready')
    expect((table.props('items') as AgentDefinition[]).map(item => item.id)).toEqual(['ready'])
    await wrapper.findAll('button').find(button => button.text().trim() === 'Clear filters')!.trigger('click')
    expect((table.props('items') as AgentDefinition[])).toHaveLength(4)
  })
})
