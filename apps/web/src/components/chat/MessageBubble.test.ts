import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, test } from 'vitest'
import MessageBubble from './MessageBubble.vue'

describe('MessageBubble', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  function mountMessage(role: 'user' | 'assistant', createdAt: number) {
    const router = createRouter({ history: createMemoryHistory(), routes: [] })

    return mount(MessageBubble, {
      props: { role, content: 'Hello', createdAt },
      global: {
        plugins: [router],
        stubs: { Icon: true },
      },
    })
  }

  test.each(['user', 'assistant'] as const)('shows a time-only row label for %s messages', (role) => {
    const createdAt = new Date(2026, 8, 12, 14, 45).getTime()
    const wrapper = mountMessage(role, createdAt)
    const time = wrapper.get('[data-testid="message-row-time"]')

    expect(time.text()).toBe(new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    }).format(createdAt))
    expect(time.attributes('datetime')).toBe(new Date(createdAt).toISOString())
    expect(time.classes()).toContain('group-hover/msg:opacity-100')
  })
})
