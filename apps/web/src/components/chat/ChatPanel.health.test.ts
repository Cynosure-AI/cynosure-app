import { shallowMount } from '@vue/test-utils'
import { reactive } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import ChatPanel from './ChatPanel.vue'
import ToolExecutionList from './ToolExecutionList.vue'
import type { DisplayMessage } from '../../stores/chat.store'

const mocks = vi.hoisted(() => ({
  chat: {
    activeAgentId: 'agent' as string | null, activeConversationId: null as string | null,
    conversations: [] as Array<{ id: string; agentId: string }>,
    messages: [] as DisplayMessage[], freeChatSubAgentIds: [] as string[], activeQuickResponses: [],
    activePostActions: new Set(), loadingMessages: false,
  },
  runtime: { availableTools: [], executionSteps: [], isExecuting: false },
  health: { healthByAgent: new Map(), loadMemoryFolders: vi.fn() },
}))
vi.mock('../../stores/chat.store', () => ({ useChatStore: () => reactive(mocks.chat) }))
vi.mock('../../stores/agent-runtime.store', () => ({ useAgentStore: () => mocks.runtime }))
vi.mock('../../stores/agent-definitions.store', () => ({ useAgentDefinitionsStore: () => ({ get: (id: string) => ({ id, name: id }) }) }))
vi.mock('../../stores/preferences.store', () => ({ usePreferencesStore: () => ({ quickResponses: false }) }))
vi.mock('../../stores/agent-health.store', () => ({ useAgentHealthStore: () => reactive(mocks.health) }))
vi.mock('../../api/http', () => ({ wsConnected: { __v_isRef: true, value: true } }))
vi.mock('vue-router', () => ({ useRoute: () => ({ fullPath: '/chat' }) }))

function mountPanel() {
  return shallowMount(ChatPanel, { global: { stubs: {
    RouterLink: { name: 'RouterLink', props: ['to'], template: '<a><slot /></a>' },
  } } })
}

describe('chat greeting health warning', () => {
  beforeEach(() => {
    mocks.chat.activeAgentId = 'agent'
    mocks.chat.activeConversationId = null
    mocks.chat.conversations = []
    mocks.health.healthByAgent.clear()
    mocks.chat.freeChatSubAgentIds = []
    mocks.chat.messages = []
  })

  test('renders saved tool messages with the shared list when events are unavailable', () => {
    mocks.chat.messages = [
      { id: 'request', role: 'assistant', content: '', createdAt: 1, toolCalls: [{ id: 'call', name: 'lookup', arguments: '{"query":"jobs"}' }] },
      { id: 'result', role: 'tool', content: 'Found jobs', createdAt: 2, toolCallId: 'call', toolSuccess: true },
    ]
    const wrapper = mountPanel()
    const list = wrapper.getComponent(ToolExecutionList)
    expect(list.props('isActive')).toBe(false)
    expect(list.props('rows')).toEqual([expect.objectContaining({
      name: 'lookup', call: { id: 'call', name: 'lookup', arguments: '{"query":"jobs"}' },
      result: expect.objectContaining({ output: 'Found jobs', success: true }),
    })])
  })

  test.each([8, 9, 10, 11])('accounts for all %i empty-state sub-agents', (count) => {
    mocks.chat.activeAgentId = null
    mocks.chat.freeChatSubAgentIds = Array.from({ length: count }, (_, index) => `agent-${index}`)
    const wrapper = mountPanel()
    const overflow = wrapper.find('[aria-label="Additional assigned sub-agents"]')
    const visibleCount = count > 8 ? 7 : count
    for (const id of mocks.chat.freeChatSubAgentIds.slice(0, visibleCount)) {
      expect(wrapper.find(`[title="${id}"]`).exists()).toBe(true)
    }
    expect(overflow.exists()).toBe(count > 8)
    if (count > 8) {
      expect(overflow.text()).toBe(`+${count - visibleCount}`)
      expect(overflow.attributes('title')).toBe(mocks.chat.freeChatSubAgentIds.slice(visibleCount).join('\n'))
    }
  })

  test('shows missing tools and sub-agents beside the greeting and links to settings', () => {
    mocks.health.healthByAgent.set('agent', { issues: ['Tool: removed-tool', 'Sub-agent: removed-agent'] })
    const wrapper = mountPanel()
    const warning = wrapper.get('[aria-label^="Agent health warning:"]')
    expect(warning.attributes('title')).toContain('Tool: removed-tool')
    expect(warning.attributes('aria-label')).toContain('Sub-agent: removed-agent')
    expect(warning.element.parentElement?.querySelector('h2')).not.toBeNull()
    expect(wrapper.findAllComponents({ name: 'RouterLink' }).at(-1)?.props('to')).toEqual({
      name: 'agent-detail', params: { id: 'agent' }, query: { returnTo: '/chat' },
    })
  })

  test('clears the warning when assignments are repaired and stays hidden in free chat', async () => {
    mocks.health.healthByAgent.set('agent', { issues: ['Tool: removed'] })
    const wrapper = mountPanel()
    expect(wrapper.find('[aria-label^="Agent health warning:"]').exists()).toBe(true)
    reactive(mocks.health).healthByAgent.set('agent', { issues: [] })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[aria-label^="Agent health warning:"]').exists()).toBe(false)
    reactive(mocks.health).healthByAgent.set('agent', { issues: ['Tool: removed'] })
    reactive(mocks.chat).activeAgentId = null
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[aria-label^="Agent health warning:"]').exists()).toBe(false)
  })

  test('validates the conversation agent rather than the selected draft agent', () => {
    mocks.chat.activeConversationId = 'conversation'
    mocks.chat.conversations = [{ id: 'conversation', agentId: 'conversation-agent' }]
    mocks.health.healthByAgent.set('conversation-agent', { issues: ['Sub-agent: missing'] })
    expect(mountPanel().get('[aria-label^="Agent health warning:"]').attributes('title'))
      .toContain('Sub-agent: missing')
  })
})
