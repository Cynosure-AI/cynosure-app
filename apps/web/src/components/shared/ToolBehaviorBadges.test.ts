import { shallowMount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import ToolBehaviorBadges from './ToolBehaviorBadges.vue'

describe('ToolBehaviorBadges', () => {
  test('renders declared read-only and external interaction hints', () => {
    const wrapper = shallowMount(ToolBehaviorBadges, {
      props: {
        annotations: {
          readOnlyHint: true,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
    })

    expect(wrapper.text()).toContain('read only')
    expect(wrapper.text()).toContain('external')
    expect(wrapper.text()).not.toContain('destructive')
    expect(wrapper.text()).not.toContain('repeat effects')
  })

  test('renders mutating behavior hints, including explicit false values', () => {
    const wrapper = shallowMount(ToolBehaviorBadges, {
      props: {
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    })

    expect(wrapper.text()).toContain('writes')
    expect(wrapper.text()).toContain('additive')
    expect(wrapper.text()).toContain('idempotent')
    expect(wrapper.text()).toContain('local scope')
  })

  test('stays hidden when a server declares no annotations', () => {
    const wrapper = shallowMount(ToolBehaviorBadges)

    expect(wrapper.find('[aria-label="Server-declared tool behavior hints"]').exists()).toBe(false)
  })
})
