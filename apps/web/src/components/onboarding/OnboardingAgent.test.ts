import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { defineComponent } from 'vue'
import { api } from '../../api/client'
import type { AgentDefinition, LLMProviderConfig, MemorySpace } from '../../api/types'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import { useProviderStore } from '../../stores/provider.store'
import OnboardingAgent from './OnboardingAgent.vue'

const SlotStub = defineComponent({ template: '<div><slot /></div>' })

function mountStep() {
  return mount(OnboardingAgent, {
    global: {
      stubs: {
        BaseCard: SlotStub,
        IconUpload: SlotStub,
        ProviderModelSelect: SlotStub,
      },
    },
  })
}

describe('OnboardingAgent', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const providers = useProviderStore()
    providers.providers = [{
      id: 'provider-1',
      name: 'Provider',
      type: 'openai',
      defaultModel: 'model-1',
    } as LLMProviderConfig]
    providers.lastUsedProviderId = 'provider-1'
  })

  test('skips without creating anything when the form is untouched', async () => {
    const definitions = useAgentDefinitionsStore()
    definitions.create = vi.fn()
    const wrapper = mountStep()

    await expect(wrapper.vm.createAgent()).resolves.toBe(true)
    expect(definitions.create).not.toHaveBeenCalled()
  })

  test('creates and assigns a dedicated memory space', async () => {
    const definitions = useAgentDefinitionsStore()
    definitions.create = vi.fn().mockResolvedValue({ id: 'agent-1' } as AgentDefinition)
    vi.spyOn(api.memorySpaces, 'list').mockResolvedValue([])
    vi.spyOn(api.memorySpaces, 'create').mockResolvedValue({
      id: 'space-1',
      relativePath: '.agents/research_assistant',
    } as MemorySpace)

    const wrapper = mountStep()
    await wrapper.get('#onboarding-agent-name').setValue('Research Assistant')
    await wrapper.get('#onboarding-agent-description').setValue('Finds reliable sources.')

    await expect(wrapper.vm.createAgent()).resolves.toBe(true)
    expect(api.memorySpaces.create).toHaveBeenCalledWith(
      'research_assistant',
      'Private memory folder for Research Assistant',
      '.agents',
    )
    expect(definitions.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Research Assistant',
      internalName: 'research_assistant',
      description: 'Finds reliable sources.',
      autoMemory: true,
      memorySpaces: ['space-1'],
    }))
  })

  test('creates an agent without default memory when memory is disabled', async () => {
    const definitions = useAgentDefinitionsStore()
    definitions.create = vi.fn().mockResolvedValue({ id: 'agent-1' } as AgentDefinition)
    const listSpaces = vi.spyOn(api.memorySpaces, 'list')

    const wrapper = mountStep()
    await wrapper.get('#onboarding-agent-name').setValue('Writer')
    await wrapper.get('button[role="switch"]').trigger('click')

    await expect(wrapper.vm.createAgent()).resolves.toBe(true)
    expect(listSpaces).not.toHaveBeenCalled()
    expect(definitions.create).toHaveBeenCalledWith(expect.objectContaining({
      autoMemory: false,
      memorySpaces: [],
    }))
  })
})
