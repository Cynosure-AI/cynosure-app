import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import ToggleSwitch from './ToggleSwitch.vue'

describe('ToggleSwitch', () => {
  test('exposes switch semantics and emits the next value', async () => {
    const wrapper = mount(ToggleSwitch, {
      props: { modelValue: false, label: 'Enable memory reranking' },
    })
    const control = wrapper.get('button[role="switch"]')

    expect(control.attributes('aria-label')).toBe('Enable memory reranking')
    expect(control.attributes('aria-checked')).toBe('false')
    await control.trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([[true]])
  })

  test('does not emit while disabled', async () => {
    const wrapper = mount(ToggleSwitch, {
      props: { modelValue: true, disabled: true, label: 'Locked setting' },
    })
    const control = wrapper.get('button[role="switch"]')

    expect(control.attributes('disabled')).toBeDefined()
    await control.trigger('click')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })
})
