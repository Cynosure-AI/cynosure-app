import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { defineComponent } from 'vue'
import type { AgentDefinition, LLMProviderConfig } from '../../api/types'
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

  test('creates an agent without creating a dedicated memory folder', async () => {
    const definitions = useAgentDefinitionsStore()
    definitions.create = vi.fn().mockResolvedValue({ id: 'agent-1' } as AgentDefinition)
    const wrapper = mountStep()
    await wrapper.get('#onboarding-agent-name').setValue('Research Assistant')
    await wrapper.get('#onboarding-agent-description').setValue('Finds reliable sources.')

    await expect(wrapper.vm.createAgent()).resolves.toBe(true)
    expect(definitions.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Research Assistant',
      internalName: 'research_assistant',
      description: 'Finds reliable sources.',
      autoMemory: false,
      memoryFolders: [],
    }))
  })
})
