import { mount } from '@vue/test-utils'
import { describe, expect, test, vi } from 'vitest'
import type { AgentDefinition } from '../../api/types'
import AgentAdvancedTab from './AgentAdvancedTab.vue'

vi.mock('../../stores/provider.store', () => ({
  useProviderStore: () => ({ providers: [], loadProviders: vi.fn() }),
}))

function mountTab(thinkingEnabled: boolean, reasoningEffort: AgentDefinition['reasoningEffort']) {
  return mount(AgentAdvancedTab, {
    props: { agent: { thinkingEnabled, reasoningEffort } as AgentDefinition },
    global: { stubs: { ToggleSwitch: true, ProviderModelSelect: true } },
  })
}

describe('AgentAdvancedTab reasoning slider', () => {
  test('turns reasoning off while retaining the saved effort', async () => {
    const wrapper = mountTab(true, 'high')
    const slider = wrapper.get<HTMLInputElement>('[aria-label="Default reasoning level"]')
    expect(slider.element.value).toBe('4')
    await slider.setValue('0')
    expect(wrapper.emitted('updateReasoning')).toEqual([[false, 'high']])
  })

  test('selecting a level from Off enables reasoning', async () => {
    const wrapper = mountTab(false, 'low')
    const slider = wrapper.get<HTMLInputElement>('[aria-label="Default reasoning level"]')
    expect(slider.element.value).toBe('0')
    await slider.setValue('5')
    expect(wrapper.emitted('updateReasoning')).toEqual([[true, 'xhigh']])
  })
})
