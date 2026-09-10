import { mount } from '@vue/test-utils'
import { describe, expect, test, vi } from 'vitest'
import SplitButton from './SplitButton.vue'

describe('SplitButton', () => {
  test('runs the primary action and exposes a closable options menu', async () => {
    const onPrimary = vi.fn()
    const wrapper = mount(SplitButton, {
      props: { primaryLabel: 'Resume analysis', menuLabel: 'Analysis options', onPrimary },
      slots: {
        default: 'Resume 4/7',
        menu: '<button role="menuitem">Cancel</button>',
      },
      global: { stubs: { Icon: true } },
    })

    await wrapper.get('[aria-label="Resume analysis"]').trigger('click')
    expect(onPrimary).toHaveBeenCalledOnce()
    await wrapper.get('[aria-label="Analysis options"]').trigger('click')
    expect(wrapper.get('[role="menu"]').text()).toContain('Cancel')
  })
})
