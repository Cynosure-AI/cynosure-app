import { DOMWrapper, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useChatStore } from '../../../stores/chat.store'
import ThinkingModeButton from './ThinkingModeButton.vue'

vi.mock('../../../stores/chat.store', async () => {
  const { reactive } = await import('vue')
  const store = reactive({
    sessionThinkingEnabled: true,
    sessionReasoningEffort: 'medium',
    permissionMode: 'auto' as 'read-only' | 'auto' | 'full',
    async setPermissionMode(mode: 'read-only' | 'auto' | 'full') {
      store.permissionMode = mode
    },
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
    chatStore.permissionMode = 'auto'
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

    await new DOMWrapper(slider!).setValue('6')
    expect(chatStore.sessionThinkingEnabled).toBe(true)
    expect(chatStore.sessionReasoningEffort).toBe('max')
    expect(slider!.getAttribute('aria-valuetext')).toBe('Maximum')
    expect(wrapper.get('button').attributes('aria-label')).toBe('Reasoning level: Maximum')

    wrapper.unmount()
  })

  test('switches the chat between permission modes and marks the trigger', async () => {
    const wrapper = mount(ThinkingModeButton, {
      attachTo: document.body,
      global: {
        stubs: { Icon: true },
      },
    })
    const chatStore = useChatStore()

    await wrapper.get('button').trigger('click')
    expect(wrapper.find('.permission-badge').exists()).toBe(false)
    const options = document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    expect([...options].map((option) => option.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])

    await new DOMWrapper(options[2]!).trigger('click')

    expect(chatStore.permissionMode).toBe('full')
    expect(options[2]?.getAttribute('aria-checked')).toBe('true')
    expect(wrapper.find('.permission-badge--full').exists()).toBe(true)
    expect(wrapper.get('button').attributes('aria-label')).toBe('Reasoning level: Medium, full tool access')

    await new DOMWrapper(options[0]!).trigger('click')

    expect(chatStore.permissionMode).toBe('read-only')
    expect(wrapper.find('.permission-badge--read-only').exists()).toBe(true)
    expect(wrapper.get('button').attributes('aria-label')).toBe('Reasoning level: Medium, read-only tools')

    wrapper.unmount()
  })
})
