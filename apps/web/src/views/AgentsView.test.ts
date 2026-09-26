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
  template: '<div><div v-for="item in items" :key="item.id"><slot name="col-name" :item="item" /></div></div>',
}

const InfoColumnTable = {
  name: 'DataTable',
  props: { items: { type: Array, default: () => [] } },
  template: '<div><div v-for="item in items" :key="item.id" :data-agent-id="item.id"><slot name="col-info" :item="item" /></div></div>',
}

const TooltipStub = {
  template: '<div><slot /><slot name="content" /></div>',
}

const IconStub = {
  props: ['icon'],
  template: '<span :data-icon="icon" />',
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

    const warnings = wrapper.findAll('[aria-label^="Unavailable assignments:"]')
      .map(icon => icon.attributes('aria-label'))
    expect(warnings).toHaveLength(3)
    expect(warnings).toEqual(expect.arrayContaining([
      'Unavailable assignments: Tool: removed-tool',
      'Unavailable assignments: Memory folder: removed-folder',
      'Unavailable assignments: Sub-agent: removed-agent',
    ]))

    const table = wrapper.getComponent({ name: 'DataTable' })
    expect((table.props('columns') as Array<{ key: string }>).some(column => column.key === 'state')).toBe(false)

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

  test('shows tool discovery on the wrench and auto memory on the brain', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const definitions = useAgentDefinitionsStore()
    definitions.agents = [
      agent('tools-on', { autoToolRouting: true, autoMemory: false }),
      agent('memory-on', { autoToolRouting: false, autoMemory: true }),
    ]
    definitions.load = vi.fn().mockResolvedValue(undefined)
    useAgentStore().availableTools = []

    const wrapper = mount(AgentsView, {
      global: {
        plugins: [pinia],
        stubs: {
          DataTable: InfoColumnTable, Icon: IconStub, BaseCard: true,
          HoverTooltip: TooltipStub, ModalDialog: true, ProviderModelSelect: true,
        },
      },
    })
    await flushPromises()

    const toolsOn = wrapper.get('[data-agent-id="tools-on"]')
    const memoryOn = wrapper.get('[data-agent-id="memory-on"]')
    const toolIcon = (row: typeof toolsOn) => row.get('[data-icon="lucide:wrench"]').element.parentElement!
    const memoryIcon = (row: typeof toolsOn) => row.get('[data-icon="lucide:database"]').element.parentElement!

    expect(toolIcon(toolsOn).classList.contains('text-emerald-400')).toBe(true)
    expect(memoryIcon(toolsOn).classList.contains('text-emerald-400')).toBe(false)
    expect(toolIcon(memoryOn).classList.contains('text-emerald-400')).toBe(false)
    expect(memoryIcon(memoryOn).classList.contains('text-emerald-400')).toBe(true)
    expect(toolIcon(toolsOn).parentElement?.textContent).toContain('Automatic tool discovery is enabled')
    expect(memoryIcon(memoryOn).parentElement?.textContent).toContain('Auto memory is enabled')
  })
})
