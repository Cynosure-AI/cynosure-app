import { mount } from '@vue/test-utils'
import { describe, expect, test, vi } from 'vitest'
import SplitButton from './SplitButton.vue'

describe('SplitButton', () => {
  test('runs the primary action and exposes a closable options menu', async () => {
    const onPrimary = vi.fn()
    const wrapper = mount(SplitButton, {
      props: { primaryLabel: 'Resume Deep Research', menuLabel: 'Deep Research options', onPrimary },
      slots: {
        default: 'Resume 4/7',
        menu: '<button role="menuitem">Cancel</button>',
      },
      global: { stubs: { Icon: true } },
    })

    await wrapper.get('[aria-label="Resume Deep Research"]').trigger('click')
    expect(onPrimary).toHaveBeenCalledOnce()
    await wrapper.get('[aria-label="Deep Research options"]').trigger('click')
    const menu = document.body.querySelector('[role="menu"]')
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    expect(document.body.contains(menu)).toBe(true)
    expect(menu?.classList.contains('fixed')).toBe(true)
    expect(menu?.textContent).toContain('Cancel')
    wrapper.unmount()
  })
})
