import { shallowMount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import ContextRing from './ContextRing.vue'

const mocks = vi.hoisted(() => ({
  chatStore: {
    activeConversationId: null as string | null,
    activeAgentId: null as string | null,
    contextWindow: 1_000 as number | null,
    lastUsage: {
      promptTokens: 250,
      completionTokens: 0,
      totalTokens: 250,
      contextTokens: 250,
    } as null | {
      promptTokens: number
      completionTokens: number
      totalTokens: number
      contextTokens: number
    },
    subAgentUsage: null as null | { totalTokens: number },
  },
}))

vi.mock('../../../stores/chat.store', () => ({ useChatStore: () => mocks.chatStore }))
vi.mock('../../../stores/agent-definitions.store', () => ({
  useAgentDefinitionsStore: () => ({ get: vi.fn(() => null) }),
}))

describe('ContextRing', () => {
  const mountRing = () => shallowMount(ContextRing, {
    global: {
      stubs: {
        HoverTooltip: {
          template: '<div><slot /><slot name="content" /></div>',
        },
      },
    },
  })

  beforeEach(() => {
    mocks.chatStore.activeConversationId = null
    mocks.chatStore.subAgentUsage = null
  })

  test('does not carry context usage into a new chat', () => {
    const wrapper = mountRing()

    expect(wrapper.text()).toContain('0%')
    expect(wrapper.text()).not.toContain('25%')
  })

  test('shows usage for the active conversation', () => {
    mocks.chatStore.activeConversationId = 'conversation-1'
    const wrapper = mountRing()

    expect(wrapper.text()).toContain('25%')
  })

  test('shows sub-agent tokens separately from main context usage', () => {
    mocks.chatStore.activeConversationId = 'conversation-1'
    mocks.chatStore.subAgentUsage = { totalTokens: 600 }
    const wrapper = mountRing()

    expect(wrapper.text()).toContain('25%')
    expect(wrapper.text()).toContain('Main Agent Context')
    expect(wrapper.text()).toContain('Sub Agent Usage')
    expect(wrapper.text()).toContain('600')
  })
})
