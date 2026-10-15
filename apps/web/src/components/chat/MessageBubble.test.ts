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

  test('keeps readonly transcript messages visually user-styled without edit or retry actions', () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [] })
    const wrapper = mount(MessageBubble, {
      props: { role: 'user', content: 'Delegated task', readonly: true },
      global: { plugins: [router], stubs: { Icon: true } },
    })

    expect(wrapper.get('.chat-user-message').text()).toContain('Delegated task')
    expect(wrapper.find('[title="Edit"]').exists()).toBe(false)
    expect(wrapper.find('[title="Retry"]').exists()).toBe(false)
  })

  test.each([
    { isStreaming: true, content: '', visible: true, cursor: false },
    { isStreaming: true, content: 'Answer', visible: false, cursor: true },
    { isStreaming: false, content: 'Answer', visible: false, cursor: false },
  ])('shows animated thinking dots only while thinking streams (%o)', ({ isStreaming, content, visible, cursor }) => {
    const router = createRouter({ history: createMemoryHistory(), routes: [] })
    const wrapper = mount(MessageBubble, {
      props: { role: 'assistant', content, thinking: 'Reasoning', isStreaming },
      global: { plugins: [router], stubs: { Icon: true } },
    })

    expect(wrapper.find('.thinking-dots').exists()).toBe(visible)
    if (visible) expect(wrapper.findAll('.thinking-dot')).toHaveLength(3)
    expect(wrapper.find('[data-testid="streaming-cursor"]').exists()).toBe(cursor)
  })

  test.each([
    { isStreaming: true, content: '', spaced: false },
    { isStreaming: true, content: 'Answer', spaced: true },
    { isStreaming: false, content: 'Answer', spaced: true },
  ])('only spaces the thinking block when output follows it (%o)', ({ isStreaming, content, spaced }) => {
    const router = createRouter({ history: createMemoryHistory(), routes: [] })
    const wrapper = mount(MessageBubble, {
      props: { role: 'assistant', content, thinking: 'Reasoning', isStreaming },
      global: { plugins: [router], stubs: { Icon: true } },
    })

    expect(wrapper.get('[data-testid="thinking-block"]').classes().includes('mb-3')).toBe(spaced)
  })
})
