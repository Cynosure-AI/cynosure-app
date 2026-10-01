import { DOMWrapper, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useChatStore } from '../../../stores/chat.store'
import ThinkingModeButton from './ThinkingModeButton.vue'

vi.mock('../../../stores/chat.store', async () => {
  const { reactive } = await import('vue')
  const store = reactive({
    sessionThinkingEnabled: true,
    sessionReasoningEffort: 'medium',
    setSessionReasoningEffort(effort: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max') {
      store.sessionThinkingEnabled = effort !== 'off'
      if (effort !== 'off') store.sessionReasoningEffort = effort
    },
  })
  return { useChatStore: () => store }
})

describe('ThinkingModeButton', () => {
  beforeEach(() => {
    const chatStore = useChatStore()
    chatStore.sessionThinkingEnabled = true
    chatStore.sessionReasoningEffort = 'medium'
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('maps the slider endpoints to plain mode and maximum reasoning', async () => {
    const wrapper = mount(ThinkingModeButton, {
      attachTo: document.body,
      global: {
        stubs: { Icon: true },
      },
    })
    const chatStore = useChatStore()

    await wrapper.get('button').trigger('click')
    const slider = document.body.querySelector<HTMLInputElement>('input[type="range"]')
    expect(slider).not.toBeNull()
    const dots = document.body.querySelectorAll('.reasoning-slider__dot')
    expect(dots[0]?.classList.contains('reasoning-slider__dot--endpoint')).toBe(true)
    expect(dots[dots.length - 1]?.classList.contains('reasoning-slider__dot--endpoint')).toBe(true)
    expect(dots[1]?.classList.contains('reasoning-slider__dot--endpoint')).toBe(false)

    await new DOMWrapper(slider!).setValue('0')
    expect(chatStore.sessionThinkingEnabled).toBe(false)
    expect(document.body.textContent).toContain('Planning off')

    await new DOMWrapper(slider!).setValue('6')
    expect(chatStore.sessionThinkingEnabled).toBe(true)
    expect(chatStore.sessionReasoningEffort).toBe('max')
    expect(slider!.getAttribute('aria-valuetext')).toBe('Maximum')
    expect(wrapper.get('button').attributes('aria-label')).toBe('Reasoning level: Maximum')
    expect(document.body.textContent).toContain('Planning available')

    wrapper.unmount()
  })
})
