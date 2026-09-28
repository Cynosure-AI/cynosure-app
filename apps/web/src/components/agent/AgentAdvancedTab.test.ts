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

describe('AgentAdvancedTab reasoning dropdown', () => {
  test('turns reasoning off while retaining the saved effort', async () => {
    const wrapper = mountTab(true, 'high')
    const select = wrapper.get<HTMLSelectElement>('#agent-reasoning-level')
    expect(select.element.value).toBe('high')
    await select.setValue('off')
    expect(wrapper.emitted('updateReasoning')).toEqual([[false, 'high']])
  })

  test('selecting a level from Off enables reasoning', async () => {
    const wrapper = mountTab(false, 'low')
    const select = wrapper.get<HTMLSelectElement>('#agent-reasoning-level')
    expect(select.element.value).toBe('off')
    await select.setValue('xhigh')
    expect(wrapper.emitted('updateReasoning')).toEqual([[true, 'xhigh']])
  })
})
