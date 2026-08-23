import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import ResponsiveSectionLayout from './ResponsiveSectionLayout.vue'

describe('ResponsiveSectionLayout', () => {
  test('switches the mobile pane and emits back from the detail pane', async () => {
    const wrapper = mount(ResponsiveSectionLayout, {
      props: { detailOpen: false, mobileBackLabel: 'All sections' },
      slots: {
        sidebar: '<div data-test="menu">Menu</div>',
        default: '<div data-test="detail">Detail</div>',
      },
    })

    expect(wrapper.get('aside').classes()).toContain('flex')
    expect(wrapper.get('section').classes()).toContain('hidden')

    await wrapper.setProps({ detailOpen: true })
    expect(wrapper.get('aside').classes()).toContain('hidden')
    expect(wrapper.get('section').classes()).toContain('flex')

    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('back')).toHaveLength(1)
  })
})
