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
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { clear() {} },
    })
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

    await new DOMWrapper(slider!).setValue('0')
    expect(chatStore.sessionThinkingEnabled).toBe(false)
    expect(document.body.textContent).toContain('Planning off')

    await new DOMWrapper(slider!).setValue('6')
    expect(chatStore.sessionThinkingEnabled).toBe(true)
    expect(chatStore.sessionReasoningEffort).toBe('max')
    expect(document.body.textContent).toContain('maximum available reasoning effort')

    wrapper.unmount()
  })
})
