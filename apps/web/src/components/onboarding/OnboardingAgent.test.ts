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

  test('creates an agent with the same behavior defaults as the Agents page and the default memory folders', async () => {
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
      autoToolRouting: true,
      autoMemory: true,
      dreamingEnabled: true,
    }))
    expect(vi.mocked(definitions.create).mock.calls[0][0]).not.toHaveProperty('memoryFolders')
  })

  test('a template fills the draft, creates the agent and reports its name', async () => {
    const definitions = useAgentDefinitionsStore()
    definitions.create = vi.fn().mockResolvedValue({ id: 'agent-1' } as AgentDefinition)
    const wrapper = mountStep()
    const template = wrapper.findAll('button').find(button => button.text().includes('Writing Partner'))!

    await template.trigger('click')
    expect(template.attributes('aria-pressed')).toBe('true')
    expect(wrapper.emitted('draftChange')?.at(-1)).toEqual([{ hasDraft: true, valid: true }])

    await expect(wrapper.vm.createAgent()).resolves.toBe(true)
    expect(definitions.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Writing Partner',
      internalName: 'writing_partner',
      systemPrompt: expect.stringContaining('writing partner'),
    }))
    expect(wrapper.emitted('created')).toEqual([['Writing Partner']])
  })

  test('choosing the selected template again clears the draft', async () => {
    const wrapper = mountStep()
    const template = wrapper.findAll('button').find(button => button.text().includes('Coding Helper'))!

    await template.trigger('click')
    await template.trigger('click')

    expect(wrapper.get<HTMLInputElement>('#onboarding-agent-name').element.value).toBe('')
    expect(wrapper.emitted('draftChange')?.at(-1)).toEqual([{ hasDraft: false, valid: true }])
  })
})
