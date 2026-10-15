import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import ApprovalModeControl from './ApprovalModeControl.vue'

describe('ApprovalModeControl', () => {
  test('marks the active mode and emits a different selection', async () => {
    const wrapper = mount(ApprovalModeControl, {
      props: { mode: 'default', label: 'Approval for memory_search' },
    })
    const radios = wrapper.findAll('button[role="radio"]')

    expect(wrapper.get('[role="radiogroup"]').attributes('aria-label')).toBe('Approval for memory_search')
    expect(radios.map((radio) => radio.attributes('aria-checked'))).toEqual(['false', 'true', 'false'])
    await radios[1].trigger('click')
    await radios[2].trigger('click')
    expect(wrapper.emitted('change')).toEqual([['ask']])
  })

  test('highlights nothing when mixed and lets every mode be chosen', async () => {
    const wrapper = mount(ApprovalModeControl, { props: { mode: 'mixed' } })
    const radios = wrapper.findAll('button[role="radio"]')

    expect(radios.every((radio) => radio.attributes('aria-checked') === 'false')).toBe(true)
    for (const radio of radios) await radio.trigger('click')
    expect(wrapper.emitted('change')).toEqual([['allow'], ['default'], ['ask']])
  })

  test('does not emit while disabled', async () => {
    const wrapper = mount(ApprovalModeControl, { props: { mode: 'allow', disabled: true } })

    await wrapper.findAll('button[role="radio"]')[2].trigger('click')
    expect(wrapper.emitted('change')).toBeUndefined()
  })

  test('describes the resolved default result', () => {
    const wrapper = mount(ApprovalModeControl, { props: { mode: 'default', defaultAllows: false } })

    expect(wrapper.findAll('button[role="radio"]')[1].attributes('title')).toBe('Following defaults: currently asks')
  })
})
