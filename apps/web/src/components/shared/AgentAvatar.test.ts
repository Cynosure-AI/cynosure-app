import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, test } from 'vitest'
import AgentAvatar from './AgentAvatar.vue'

beforeEach(() => setActivePinia(createPinia()))

describe('AgentAvatar', () => {
  test('shows the theme logo while pending, then the generated face', async () => {
    const wrapper = mount(AgentAvatar, { props: { name: 'Cyno', pending: true } })
    const logo = wrapper.get('img')
    expect(logo.attributes('src')).not.toMatch(/^data:image\/svg\+xml,/)
    expect(logo.classes()).toContain('object-contain')

    await wrapper.setProps({ pending: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(wrapper.get('img').attributes('src')).toMatch(/^data:image\/svg\+xml,/)
  })

  test('prefers the image over the generated face once known', () => {
    const wrapper = mount(AgentAvatar, { props: { name: 'Scout', iconUrl: '/scout.png' } })
    expect(wrapper.get('img').attributes('src')).toBe('/scout.png')
  })
})
