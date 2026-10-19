import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import type { AgentDefinition } from '../api/types'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { useCynoStore } from '../stores/cyno.store'
import AgentDetailView from './AgentDetailView.vue'

const mocks = vi.hoisted(() => ({ update: vi.fn(), updateCyno: vi.fn(), setActiveAgent: vi.fn() }))
vi.mock('../api/client', () => ({ api: {
  memoryFolders: { list: vi.fn(async () => []) },
  agents: { update: mocks.update },
  cyno: { update: mocks.updateCyno },
} }))
vi.mock('../stores/provider.store', () => ({ useProviderStore: () => ({ providers: [], loadProviders: vi.fn() }) }))
vi.mock('../stores/chat.store', () => ({ useChatStore: () => ({ setActiveAgent: mocks.setActiveAgent, memoryFolders: [{}] }) }))

const original: AgentDefinition = {
  id: 'one', name: 'First agent', internalName: 'first_agent', description: 'Original description',
  category: '', iconUrl: null, providerId: '', model: '', systemPrompt: '', tools: [], subAgents: [],
  memoryFolders: [], autoApproveTools: false, autoToolRouting: false, autoMemory: false, dreamingEnabled: true,
  autoRouterProviderId: '', autoRouterModel: '', generateTitle: true, thinkingEnabled: true,
  reasoningEffort: 'medium', maxContextTokens: null, sortOrder: 0, favorite: false, createdAt: 1, updatedAt: 1,
}
const wrappers: VueWrapper[] = []
beforeEach(() => {
  vi.clearAllMocks()
  mocks.update.mockImplementation(async (_id, changes) => ({ ...original, ...changes }))
})
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  document.body.innerHTML = ''
})

async function setup(path = '/agents/one') {
  const pinia = createPinia()
  setActivePinia(pinia)
  const definitions = useAgentDefinitionsStore()
  definitions.agents = [{ ...original }, { ...original, id: 'two', name: 'Second agent' }]
  definitions.load = vi.fn(async () => {})
  const cyno = useCynoStore()
  cyno.profile = {
    name: 'Cyno', iconUrl: null, systemPrompt: '', providerId: '', model: '', tools: null, memoryFolders: null,
    subAgents: [], thinkingEnabled: true, reasoningEffort: 'medium', autoToolRouting: false, autoMemory: false,
    dreamingEnabled: true, updatedAt: 1, effective: { tools: [], memoryFolders: [] },
  }
  mocks.updateCyno.mockImplementation(async changes => ({ ...cyno.profile, ...changes }))
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/agents/:id', name: 'agent-detail', component: AgentDetailView },
    { path: '/cyno', name: 'cyno', component: AgentDetailView },
    { path: '/agents', name: 'agents', component: { template: '<div>Agents</div>' } },
    { path: '/chat', name: 'triggers-chat', component: { template: '<div>Chat</div>' } },
  ] })
  await router.push(path)
  const wrapper = mount(RouterView, { attachTo: document.body, global: {
    plugins: [pinia, router],
    stubs: { Icon: true, IconUpload: true, ProviderModelSelect: true, PromptSmartTagPicker: true,
      AgentToolsTab: true, AgentMemoryTab: true, AgentSubAgentsTab: true, AgentAdvancedTab: true },
  } })
  wrappers.push(wrapper)
  await flushPromises()
  const name = () => wrapper.get('input[type="text"]')
  return { wrapper, router, definitions, name, cyno }
}

function dialogButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find(button => button.textContent?.trim() === label)
  if (!button) throw new Error(`Missing dialog button: ${label}`)
  return button
}

describe('agent settings explicit save', () => {
  test('buffers typing and tab changes, validates, and saves all changes in one request', async () => {
    const { wrapper, name, definitions } = await setup()
    expect(wrapper.get('[data-testid="save-agent"]').attributes('disabled')).toBeDefined()
    await name().setValue('Changed name')
    await wrapper.get('textarea').setValue('Changed description')
    expect(mocks.update).not.toHaveBeenCalled()
    expect(definitions.get('one')?.name).toBe('First agent')
    await wrapper.findAll('[role="tab"]')[1].trigger('click')
    await wrapper.findAll('[role="tab"]')[0].trigger('click')
    expect(name().element).toHaveProperty('value', 'Changed name')
    await name().setValue('   ')
    expect(wrapper.get('[data-testid="save-agent"]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('Name is required.')
    await name().setValue('Changed name')
    await wrapper.get('[data-testid="save-agent"]').trigger('click')
    await flushPromises()
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith('one', { name: 'Changed name', description: 'Changed description' })
    expect(wrapper.get('[data-testid="save-agent"]').attributes('disabled')).toBeDefined()
  })

  test('cancel stays in the editor and discard leaves without saving', async () => {
    const { router, name, definitions } = await setup()
    await name().setValue('Unsaved')
    const cancelled = router.push('/agents')
    await flushPromises()
    dialogButton('Cancel').click()
    await cancelled
    expect(router.currentRoute.value.path).toBe('/agents/one')
    expect(name().element).toHaveProperty('value', 'Unsaved')
    const discarded = router.push('/agents')
    await flushPromises()
    dialogButton('Discard').click()
    await discarded
    expect(router.currentRoute.value.path).toBe('/agents')
    expect(definitions.get('one')?.name).toBe('First agent')
    expect(mocks.update).not.toHaveBeenCalled()
  })

  test('saves before switching to another agent and initializes its own draft', async () => {
    const { router, name } = await setup()
    await name().setValue('Saved first')
    const navigation = router.push('/agents/two')
    await flushPromises()
    dialogButton('Save').click()
    await navigation
    await flushPromises()
    expect(mocks.update).toHaveBeenCalledWith('one', { name: 'Saved first' })
    expect(router.currentRoute.value.path).toBe('/agents/two')
    expect(name().element).toHaveProperty('value', 'Second agent')
  })

  test('a failed save retains the draft and keeps the exit dialog open for retry', async () => {
    const { router, name } = await setup()
    mocks.update.mockRejectedValueOnce(new Error('Connection lost'))
    await name().setValue('Keep this draft')
    const navigation = router.push('/agents')
    await flushPromises()
    dialogButton('Save').click()
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/agents/one')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Connection lost')
    expect(name().element).toHaveProperty('value', 'Keep this draft')
    dialogButton('Save').click()
    await navigation
    expect(router.currentRoute.value.path).toBe('/agents')
  })

  test('blocks saving invalid drafts in the exit dialog but allows discarding them', async () => {
    const { router, name } = await setup()
    await name().setValue('')
    const navigation = router.push('/agents')
    await flushPromises()
    expect(dialogButton('Save').disabled).toBe(true)
    dialogButton('Discard').click()
    await navigation
    expect(mocks.update).not.toHaveBeenCalled()
  })

  test('protects refreshes only while dirty and clears dirty state when edits are reverted', async () => {
    const { wrapper, name } = await setup()
    await name().setValue('Unsaved')
    const dirtyEvent = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirtyEvent)
    expect(dirtyEvent.defaultPrevented).toBe(true)
    await name().setValue(original.name)
    expect(wrapper.get('[data-testid="save-agent"]').attributes('disabled')).toBeDefined()
    const cleanEvent = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(cleanEvent)
    expect(cleanEvent.defaultPrevented).toBe(false)
  })

  test('Go to chat waits for the unsaved changes decision before changing the active agent', async () => {
    const { wrapper, name, router } = await setup()
    await name().setValue('Unsaved')
    await wrapper.findAll('button').find(button => button.text() === 'Go to chat')!.trigger('click')
    expect(mocks.setActiveAgent).not.toHaveBeenCalled()
    dialogButton('Discard').click()
    await flushPromises()
    expect(mocks.setActiveAgent).toHaveBeenCalledWith('one')
    expect(router.currentRoute.value.path).toBe('/chat')
  })

  test('Cyno uses the same explicit save flow, including reasoning settings', async () => {
    const { wrapper, name, cyno } = await setup('/cyno')
    await name().setValue('Captain')
    await wrapper.get('#agent-reasoning-level').setValue('5')
    expect(cyno.profile?.name).toBe('Cyno')
    expect(mocks.updateCyno).not.toHaveBeenCalled()
    await wrapper.get('[data-testid="save-agent"]').trigger('click')
    await flushPromises()
    expect(mocks.updateCyno).toHaveBeenCalledWith({ name: 'Captain', reasoningEffort: 'xhigh' })
  })
})
