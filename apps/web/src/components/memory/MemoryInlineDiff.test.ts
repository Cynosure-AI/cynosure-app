import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import MemoryInlineDiff from './MemoryInlineDiff.vue'

describe('MemoryInlineDiff', () => {
  test('renders readable inline additions and replacements without patch syntax', () => {
    const wrapper = mount(MemoryInlineDiff, {
      props: {
        segments: [
          { type: 'unchanged', text: 'Lives in ' },
          { type: 'removed', text: 'Berlin' },
          { type: 'added', text: 'Hamburg' },
          { type: 'unchanged', text: '.\n' },
        ],
      },
    })

    expect(wrapper.text()).toContain('Lives in BerlinHamburg.')
    expect(wrapper.text()).not.toContain('@@')
    expect(wrapper.get('span.line-through').text()).toBe('Berlin')
    expect(wrapper.get('span.text-emerald-200').text()).toBe('Hamburg')
  })
})
