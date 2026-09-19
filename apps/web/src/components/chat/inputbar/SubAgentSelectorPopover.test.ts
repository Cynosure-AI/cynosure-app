import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { h, nextTick } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { api } from '../../../api/client'
import type { AgentDefinition } from '../../../api/types'
import { useAgentDefinitionsStore } from '../../../stores/agent-definitions.store'
import { useChatStore } from '../../../stores/chat.store'
import SubAgentSelectorPopover from './SubAgentSelectorPopover.vue'

vi.mock('../../../composables/useProviderLogos', () => ({
  useProviderLogos: () => ({ logoUrl: () => null }),
}))

describe('SubAgentSelectorPopover', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
    setActivePinia(createPinia())
    vi.spyOn(api.memoryFolders, 'list').mockResolvedValue([])
  })

  test('searches and selects sub-agents in an in-place popover', async () => {
    const agentDefs = useAgentDefinitionsStore()
    const chatStore = useChatStore()
    agentDefs.agents = [
      agent('researcher', 'Researcher', 'Finds reliable sources'),
      agent('writer', 'Writer', 'Drafts final copy'),
    ]

    const wrapper = mount(SubAgentSelectorPopover, {
      attachTo: document.body,
      slots: {
        trigger: ({ toggle }: { toggle: () => void }) => h('button', { 'data-test': 'trigger', onClick: toggle }, 'Agents'),
      },
      global: { stubs: { Icon: true } },
    })

    await wrapper.get('[data-test="trigger"]').trigger('click')
    await nextTick()

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.querySelector('[aria-label="Sub-agents"]')).not.toBeNull()

    const search = document.body.querySelector<HTMLInputElement>('[aria-label="Search sub-agents"]')!
    search.value = 'sources'
    search.dispatchEvent(new Event('input'))
    await nextTick()

    expect(document.body.textContent).toContain('Researcher')
    expect(document.body.textContent).not.toContain('Writer')

    document.body.querySelector<HTMLButtonElement>('[aria-label="Toggle Researcher"]')?.click()
    await nextTick()
    expect(chatStore.freeChatSubAgentIds).toEqual(['researcher'])

    wrapper.unmount()
  })

  test('lists enabled sub-agents before the remaining agents', async () => {
    const agentDefs = useAgentDefinitionsStore()
    const chatStore = useChatStore()
    agentDefs.agents = [
      agent('researcher', 'Researcher', 'Finds reliable sources'),
      agent('writer', 'Writer', 'Drafts final copy'),
      agent('reviewer', 'Reviewer', 'Checks the result'),
    ]
    const wrapper = mount(SubAgentSelectorPopover, {
      attachTo: document.body,
      slots: {
        trigger: ({ toggle }: { toggle: () => void }) => h('button', { 'data-test': 'trigger', onClick: toggle }, 'Agents'),
      },
      global: { stubs: { Icon: true } },
    })

    chatStore.freeChatSubAgentIds.splice(0)
    await wrapper.get('[data-test="trigger"]').trigger('click')
    await nextTick()

    const menus = document.body.querySelectorAll<HTMLElement>('[role="menu"][aria-label="Sub-agents"]')
    const menu = menus.item(menus.length - 1)
    menu.querySelector<HTMLButtonElement>('[aria-label="Toggle Writer"]')?.click()
    menu.querySelector<HTMLButtonElement>('[aria-label="Toggle Reviewer"]')?.click()
    await nextTick()

    const labels = [...menu.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')]
      .map((element) => element.getAttribute('aria-label'))
    expect(labels).toEqual(['Toggle Writer', 'Toggle Reviewer', 'Toggle Researcher'])

    wrapper.unmount()
  })
})

function agent(id: string, name: string, description: string): AgentDefinition {
  return {
    id,
    name,
    internalName: name.toLowerCase(),
    description,
    systemPrompt: '',
    providerId: 'provider',
    modelId: 'model',
    iconUrl: null,
    subAgents: [],
    toolNames: [],
    memoryFolderIds: [],
    createdAt: 0,
    updatedAt: 0,
  } as unknown as AgentDefinition
}
