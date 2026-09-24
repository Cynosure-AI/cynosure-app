import { describe, expect, test } from 'vitest'
import { mount } from '@vue/test-utils'
import QuickResponses from './QuickResponses.vue'

describe('QuickResponses', () => {
  test('renders at most three suggestions and emits a selection', async () => {
    const wrapper = mount(QuickResponses, {
      props: { suggestions: ['One', 'Two', 'Three', 'Four'] },
      global: { stubs: { Icon: true } },
    })

    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(3)
    await buttons[1].trigger('click')
    expect(wrapper.emitted('select')).toEqual([['Two']])
    expect(buttons[1].attributes('title')).toBe('Send quick response: Two')
  })

  test('shows post-turn progress without placeholder buttons', () => {
    const wrapper = mount(QuickResponses, {
      props: { suggestions: [], loading: true },
      global: { stubs: { Icon: true } },
    })

    expect(wrapper.text()).toContain('Thinking of follow-ups')
    expect(wrapper.findAll('button')).toHaveLength(0)
  })
})
