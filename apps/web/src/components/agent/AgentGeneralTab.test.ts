import { mount } from '@vue/test-utils'
import { describe, expect, test, vi } from 'vitest'
import type { AgentDefinition } from '../../api/types'
import AgentGeneralTab from './AgentGeneralTab.vue'

vi.mock('../../stores/cyno.store', () => ({ useCynoStore: () => ({ defaults: null }) }))
vi.mock('../../stores/provider.store', () => ({
  useProviderStore: () => ({ providers: [], loadProviders: vi.fn() }),
}))

function mountTab(thinkingEnabled: boolean, reasoningEffort: AgentDefinition['reasoningEffort']) {
  return mount(AgentGeneralTab, {
    props: { agent: { thinkingEnabled, reasoningEffort } as AgentDefinition },
    global: { stubs: { ToggleSwitch: true, ProviderModelSelect: true, IconUpload: true, PromptSmartTagPicker: true } },
  })
}

describe('AgentGeneralTab reasoning slider', () => {
  test('turns reasoning off while retaining the saved effort', async () => {
    const wrapper = mountTab(true, 'high')
    const select = wrapper.get<HTMLInputElement>('#agent-reasoning-level')
    expect(select.element.value).toBe('4')
    await select.setValue('0')
    expect(wrapper.emitted('updateReasoning')).toEqual([[false, 'high']])
  })

  test('selecting a level from Off enables reasoning', async () => {
    const wrapper = mountTab(false, 'low')
    const select = wrapper.get<HTMLInputElement>('#agent-reasoning-level')
    expect(select.element.value).toBe('0')
    await select.setValue('5')
    expect(wrapper.emitted('updateReasoning')).toEqual([[true, 'xhigh']])
  })
})
