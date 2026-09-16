import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import PreResponseActionsCard from './PreResponseActionsCard.vue'

describe('PreResponseActionsCard', () => {
  test('presents title generation as a utility action and emits cancel', async () => {
    const wrapper = mount(PreResponseActionsCard, {
      props: { actions: ['generating-title'] },
      global: { stubs: { Icon: true } },
    })

    expect(wrapper.text()).toContain('Generating title')
    expect(wrapper.text()).not.toContain('Preparing response')
    expect(wrapper.text()).not.toContain('Pre-response actions')
    expect(wrapper.text()).not.toContain('Post-turn')

    await wrapper.get('[aria-label="Cancel title generation"]').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })
})
