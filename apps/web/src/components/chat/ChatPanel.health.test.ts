import { shallowMount } from '@vue/test-utils'
import { reactive } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import ChatPanel from './ChatPanel.vue'

const mocks = vi.hoisted(() => ({
  chat: {
    activeAgentId: 'agent' as string | null, activeConversationId: null as string | null,
    conversations: [] as Array<{ id: string; agentId: string }>,
    messages: [], freeChatSubAgentIds: [], activeQuickResponses: [],
    activePostActions: new Set(), loadingMessages: false,
  },
  runtime: { executionSteps: [], isExecuting: false },
  health: { healthByAgent: new Map(), loadMemoryFolders: vi.fn() },
}))
vi.mock('../../stores/chat.store', () => ({ useChatStore: () => reactive(mocks.chat) }))
vi.mock('../../stores/agent-runtime.store', () => ({ useAgentStore: () => mocks.runtime }))
vi.mock('../../stores/agent-definitions.store', () => ({ useAgentDefinitionsStore: () => ({ get: () => ({ name: 'Agent' }) }) }))
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
