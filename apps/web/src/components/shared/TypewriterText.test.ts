import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import TypewriterText from './TypewriterText.vue'

describe('TypewriterText', () => {
  test('lays out every character up front and staggers their reveal', () => {
    const wrapper = mount(TypewriterText, { props: { text: 'Hi there.', start: 300, step: 40 } })
    const chars = wrapper.findAll('.tw-char')

    expect(chars.map(char => char.text() || ' ').join('')).toBe('Hi there.')
    expect(chars[0].attributes('style')).toContain('--tw-delay: 300ms')
    expect(chars[2].attributes('style')).toContain('--tw-delay: 380ms')
    expect(chars.at(-1)?.attributes('style')).toContain('--tw-delay: 620ms')
    expect(chars.filter(char => char.classes('tw-char--last'))).toHaveLength(1)
    expect(chars.at(-1)?.classes()).toContain('tw-char--last')
  })

  test('screen readers get the whole text instead of the typed characters', () => {
    const wrapper = mount(TypewriterText, { props: { text: 'Late-night focus.' } })

    expect(wrapper.get('.sr-only').text()).toBe('Late-night focus.')
    expect(wrapper.get('[aria-hidden="true"]').find('.tw-char').exists()).toBe(true)
  })

  test('words stay unbroken while spaces remain break points', () => {
    const wrapper = mount(TypewriterText, { props: { text: 'One more thing' } })
    const words = wrapper.findAll('.whitespace-nowrap')

    expect(words.map(word => word.text())).toEqual(['One', 'more', 'thing'])
    // The typed copy must keep its real spaces, not just the screen-reader copy.
    expect(wrapper.get('[aria-hidden="true"]').element.textContent).toBe('One more thing')
  })
})
