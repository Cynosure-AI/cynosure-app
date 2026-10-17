import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import MessageBubble from './MessageBubble.vue'

describe('MessageBubble', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
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
    { isStreaming: true, content: '', visible: true, caret: 'none' },
    { isStreaming: true, content: 'Answer', visible: false, caret: 'inline' },
    { isStreaming: false, content: 'Answer', visible: false, caret: 'none' },
  ])('shows animated thinking dots only while thinking streams (%o)', ({ isStreaming, content, visible, caret }) => {
    const router = createRouter({ history: createMemoryHistory(), routes: [] })
    const wrapper = mount(MessageBubble, {
      props: { role: 'assistant', content, thinking: 'Reasoning', isStreaming },
      global: { plugins: [router], stubs: { Icon: true } },
    })

    expect(wrapper.find('.thinking-dots').exists()).toBe(visible)
    if (visible) expect(wrapper.findAll('.thinking-dot')).toHaveLength(3)
    expect(wrapper.find('.msg-markdown--streaming').exists()).toBe(caret === 'inline')
    expect(wrapper.find('[data-testid="streaming-cursor"]').exists()).toBe(false)
  })

  test('shows a standalone caret while waiting for the first answer text', () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [] })
    const wrapper = mount(MessageBubble, {
      props: { role: 'assistant', content: '', isStreaming: true },
      global: { plugins: [router], stubs: { Icon: true } },
    })

    expect(wrapper.find('[data-testid="streaming-cursor"]').exists()).toBe(true)
  })

  test.each([
    { props: { isStreaming: true, content: '', thinkingStartedAt: Date.now() }, label: 'Thinking' },
    { props: { content: 'Answer', thinkingStartedAt: 1_000, thinkingEndedAt: 13_400 }, label: 'Thought for 12s' },
    { props: { content: 'Answer' }, label: 'Thought process' },
  ])('labels the thinking block by phase (%o)', ({ props, label }) => {
    const router = createRouter({ history: createMemoryHistory(), routes: [] })
    const wrapper = mount(MessageBubble, {
      props: { role: 'assistant', thinking: 'Reasoning', ...props },
      global: { plugins: [router], stubs: { Icon: true } },
    })

    expect(wrapper.get('[data-testid="thinking-block"] button').text()).toContain(label)
  })

  test('holds each previewed thought for a moment before showing the newest', async () => {
    vi.useFakeTimers()
    const router = createRouter({ history: createMemoryHistory(), routes: [] })
    const first = 'Checking the calendar for conflicts.'
    const wrapper = mount(MessageBubble, {
      props: { role: 'assistant', content: '', thinking: first, isStreaming: true },
      global: { plugins: [router], stubs: { Icon: true } },
    })
    const header = () => wrapper.get('[data-testid="thinking-block"] button')
    expect(header().text()).toContain(first)

    // The same paragraph keeps growing in place.
    await wrapper.setProps({ thinking: `${first} Two found` })
    expect(header().text()).toContain('Two found')

    // A new paragraph waits out the hold; later ones replace it while it waits.
    await wrapper.setProps({ thinking: `${first} Two found\nMoving the dentist appointment` })
    await wrapper.setProps({ thinking: `${first} Two found\nMoving the dentist appointment\nDrafting a reply to the clinic` })
    expect(header().text()).toContain('Two found')

    vi.advanceTimersByTime(1600)
    await wrapper.vm.$nextTick()
    expect(header().text()).toContain('Drafting a reply to the clinic')
    expect(header().text()).not.toContain('dentist')
  })

  test('shows the reply latency next to token usage', () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [] })
    const wrapper = mount(MessageBubble, {
      props: { role: 'assistant', content: 'Done', model: 'model-x', contextTokens: 10, promptTokens: 8, completionTokens: 4, latencyMs: 4_250 },
      global: { plugins: [router], stubs: { Icon: true } },
    })

    expect(wrapper.get('.msg-meta').text()).toContain('4.3s')
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
