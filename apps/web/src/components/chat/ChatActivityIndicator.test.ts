import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import ChatActivityIndicator from './ChatActivityIndicator.vue'

describe('ChatActivityIndicator', () => {
  test('renders a status and optionally emits cancel', async () => {
    const wrapper = mount(ChatActivityIndicator, {
      props: { label: 'Generating title…', cancelLabel: 'Cancel title generation' },
      global: { stubs: { Icon: true } },
    })

    expect(wrapper.text()).toContain('Generating title')
    expect(wrapper.attributes('role')).toBe('status')
    await wrapper.get('[aria-label="Cancel title generation"]').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })
})
