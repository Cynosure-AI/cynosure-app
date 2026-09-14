import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, test } from 'vitest'
import { useAgentStore, type ToolInfo } from '../../stores/agent-runtime.store'
import ToolSelector from './ToolSelector.vue'
import { memoryAutomaticToolStates } from '../../utils/internal-tools'

describe('ToolSelector requirements', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  test('keeps tools with unmet requirements visible but unselectable', async () => {
    const store = useAgentStore()
    store.availableTools = [
      tool('builtin::schedule_create', 'schedule_create'),
      tool('builtin::read_file', 'read_file'),
    ]
    const wrapper = mount(ToolSelector, {
      props: {
        modelValue: [],
        toolRequirements: {
          schedule_create: { met: false, criteria: 'agent selected' },
        },
      },
    })

    expect(wrapper.text()).toContain('1 require agent')
    await wrapper.get('button.text-accent-400').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([[['builtin::read_file']]])

    await wrapper.get('section button').trigger('click')
    const checkboxes = wrapper.findAll('input[type="checkbox"]')
    expect(checkboxes).toHaveLength(2)
    expect(checkboxes[0].attributes('disabled')).toBeDefined()
    expect(checkboxes[0].attributes('title')).toBe('requires: agent selected')
    expect(checkboxes[1].attributes('disabled')).toBeUndefined()
    expect(wrapper.text()).toContain('requires: agent selected')
  })

  test('allows tools once their requirements are met', async () => {
    const store = useAgentStore()
    store.availableTools = [tool('builtin::schedule_create', 'schedule_create')]
    const wrapper = mount(ToolSelector, {
      props: {
        modelValue: [],
        toolRequirements: {
          schedule_create: { met: true, criteria: 'agent selected' },
        },
      },
    })

    await wrapper.get('button.text-accent-400').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([[['builtin::schedule_create']]])
  })

  test.each(['memory_create', 'memory_append', 'memory_replace_range', 'memory_replace_all', 'memory_remove_all', 'memory_remove_range'])('automatically enables %s with a memory folder', async (name) => {
    const store = useAgentStore()
    store.availableTools = [tool(`builtin:memory::${name}`, name)]
    const wrapper = mount(ToolSelector, {
      props: {
        modelValue: [],
        automaticToolStates: memoryAutomaticToolStates(true),
      },
    })

    await wrapper.get('section button').trigger('click')
    const checkbox = wrapper.get('input[type="checkbox"]')
    expect(checkbox.attributes('disabled')).toBeDefined()
    expect((checkbox.element as HTMLInputElement).checked).toBe(true)

    await wrapper.setProps({ automaticToolStates: memoryAutomaticToolStates(false) })
    expect((checkbox.element as HTMLInputElement).checked).toBe(false)
  })

  test.each([
    'knowledge_assert', 'knowledge_delete',
    'knowledge_entity_merge',
  ])('allows manual %s selection alongside automatic knowledge tools', async (name) => {
    const store = useAgentStore()
    const mergeKey = `builtin:memory::${name}`
    store.availableTools = [tool(mergeKey, name)]
    const wrapper = mount(ToolSelector, {
      props: {
        modelValue: [],
        automaticToolStates: {
          knowledge_search: { active: true, criteria: 'memory folder selected' },
        },
      },
    })

    await wrapper.get('section button').trigger('click')
    const checkbox = wrapper.get('input[type="checkbox"]')
    expect(checkbox.attributes('disabled')).toBeUndefined()
    expect((checkbox.element as HTMLInputElement).checked).toBe(false)
    await checkbox.setValue(true)
    expect(wrapper.emitted('update:modelValue')).toEqual([[[mergeKey]]])
  })
})

function tool(key: string, name: string): ToolInfo {
  return {
    key,
    name,
    executionName: name,
    description: name,
    parameters: {},
    autoApprove: false,
    usesDefaultApproval: true,
    namespace: { id: 'builtin', label: 'Built-In' },
    ambiguous: false,
  }
}
