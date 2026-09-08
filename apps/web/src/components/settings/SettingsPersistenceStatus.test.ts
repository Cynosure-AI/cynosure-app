import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import SettingsPersistenceStatus from './SettingsPersistenceStatus.vue'

describe('SettingsPersistenceStatus', () => {
  test('stays hidden when no action is needed', async () => {
    const wrapper = mount(SettingsPersistenceStatus, { props: { mode: 'auto' } })
    expect(wrapper.text()).toBe('')

    await wrapper.setProps({ mode: 'manual' })
    expect(wrapper.text()).toBe('')

    await wrapper.setProps({ state: 'saved' })
    expect(wrapper.text()).toBe('')
  })

  test.each([
    ['dirty', 'Unsaved changes'],
    ['saving', 'Saving…'],
    ['error', 'Could not save. Try again.'],
  ] as const)('renders the %s state through a live region', (state, label) => {
    const wrapper = mount(SettingsPersistenceStatus, {
      props: { mode: 'manual', state },
    })

    expect(wrapper.attributes('role')).toBe('status')
    expect(wrapper.attributes('aria-live')).toBe('polite')
    expect(wrapper.text()).toContain(label)
  })

  test('uses an actionable custom error message', () => {
    const wrapper = mount(SettingsPersistenceStatus, {
      props: { mode: 'auto', state: 'error', message: 'Connection failed. Try again.' },
    })

    expect(wrapper.text()).toContain('Connection failed. Try again.')
  })
})
