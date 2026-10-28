import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AgentDefinition } from '../../api/types'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import AgentSubAgentsTab from './AgentSubAgentsTab.vue'

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mocks.push }),
}))

function makeAgent(overrides: Partial<AgentDefinition>): AgentDefinition {
  return {
    id: 'agent',
    name: 'Agent',
    internalName: 'agent',
    description: '',
    tools: [],
    subAgents: [],
    autoToolRouting: false,
    favorite: false,
    model: '',
    iconUrl: null,
    ...overrides,
  } as AgentDefinition
}

const orchestrator = makeAgent({ id: 'orchestrator', name: 'Orchestrator', internalName: 'orchestrator', subAgents: [{ agentId: 'researcher' }] })
const researcher = makeAgent({ id: 'researcher', name: 'Researcher', internalName: 'researcher', description: 'Finds sources' })
const writer = makeAgent({ id: 'writer', name: 'Writer', internalName: 'writer', description: 'Drafts text' })
const researcherCopy = makeAgent({ id: 'researcher-copy', name: 'Researcher Copy', internalName: 'researcher' })

describe('AgentSubAgentsTab', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAgentDefinitionsStore().agents = [orchestrator, researcher, writer, researcherCopy]
    mocks.push.mockReset()
  })

  test('lists assigned sub-agents and excludes self and assigned agents from the library', () => {
    const wrapper = mount(AgentSubAgentsTab, { props: { agent: orchestrator } })

    expect(wrapper.find('[data-test="assigned-researcher"]').text()).toContain('Finds sources')
    expect(wrapper.find('[data-test="candidate-orchestrator"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="candidate-researcher"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="candidate-writer"]').exists()).toBe(true)
  })

  test('adds a sub-agent with one click', async () => {
    const wrapper = mount(AgentSubAgentsTab, { props: { agent: orchestrator } })

    await wrapper.find('[data-test="candidate-writer"]').trigger('click')
    expect(wrapper.emitted('update')).toEqual([['subAgents', [{ agentId: 'researcher' }, { agentId: 'writer' }]]])
  })

  test('blocks agents whose internal name is already assigned', async () => {
    const wrapper = mount(AgentSubAgentsTab, { props: { agent: orchestrator } })
    const blocked = wrapper.find('[data-test="candidate-researcher-copy"]')

    expect(blocked.attributes('disabled')).toBeDefined()
    expect(blocked.text()).toContain('already uses the internal name')
    await blocked.trigger('click')
    expect(wrapper.emitted('update')).toBeUndefined()
  })

  test('removes an assigned sub-agent', async () => {
    const wrapper = mount(AgentSubAgentsTab, { props: { agent: orchestrator } })

    await wrapper.find('[aria-label="Remove Researcher"]').trigger('click')
    expect(wrapper.emitted('update')).toEqual([['subAgents', []]])
  })

  test('filters the library by search text', async () => {
    const wrapper = mount(AgentSubAgentsTab, { props: { agent: orchestrator } })

    await wrapper.find('input[aria-label="Search agents"]').setValue('drafts')
    expect(wrapper.find('[data-test="candidate-writer"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="candidate-researcher-copy"]').exists()).toBe(false)
  })

  test('assigns a sub-agent by dragging it onto the assigned column', async () => {
    const wrapper = mount(AgentSubAgentsTab, { props: { agent: orchestrator } })

    await wrapper.find('[data-test="candidate-writer"]').trigger('dragstart')
    await wrapper.find('[data-test="assigned-sub-agents"]').trigger('dragover')
    await wrapper.find('[data-test="assigned-sub-agents"]').trigger('drop')
    expect(wrapper.emitted('update')).toEqual([['subAgents', [{ agentId: 'researcher' }, { agentId: 'writer' }]]])
  })

  test('removes a sub-agent by dragging it back to the library', async () => {
    const wrapper = mount(AgentSubAgentsTab, { props: { agent: orchestrator } })

    await wrapper.find('[data-test="assigned-researcher"]').trigger('dragstart')
    await wrapper.find('[data-test="sub-agent-library"]').trigger('drop')
    expect(wrapper.emitted('update')).toEqual([['subAgents', []]])
  })

  test('ignores drops onto the column the agent came from', async () => {
    const wrapper = mount(AgentSubAgentsTab, { props: { agent: orchestrator } })

    await wrapper.find('[data-test="candidate-writer"]').trigger('dragstart')
    await wrapper.find('[data-test="sub-agent-library"]').trigger('drop')
    expect(wrapper.emitted('update')).toBeUndefined()
  })
})
