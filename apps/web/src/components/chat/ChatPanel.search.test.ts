import { shallowMount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import ChatPanel from './ChatPanel.vue'
import type { DisplayMessage } from '../../stores/chat.store'

const mocks = vi.hoisted(() => ({
  chat: {
    activeAgentId: 'agent' as string | null, activeConversationId: 'c-9' as string | null,
    conversations: [] as Array<{ id: string; agentId: string }>,
    messages: [] as DisplayMessage[], sessionSubAgentIds: [] as string[], activeQuickResponses: [],
    activePostActions: new Set(), loadingMessages: false,
  },
  runtime: { availableTools: [], executionSteps: [], isExecuting: false },
  health: { healthByAgent: new Map(), loadMemoryFolders: vi.fn() },
}))
vi.mock('../../stores/chat.store', () => ({ useChatStore: () => reactive(mocks.chat) }))
vi.mock('../../stores/agent-runtime.store', () => ({ useAgentStore: () => reactive(mocks.runtime) }))
vi.mock('../../stores/agent-definitions.store', () => ({ useAgentDefinitionsStore: () => ({ get: (id: string) => ({ id, name: id }) }) }))
vi.mock('../../stores/preferences.store', () => ({ usePreferencesStore: () => ({}) }))
vi.mock('../../stores/agent-health.store', () => ({ useAgentHealthStore: () => reactive(mocks.health) }))
vi.mock('../../stores/cyno.store', () => ({ useCynoStore: () => ({ profile: null, name: 'Cyno', iconUrl: 'logo.png' }) }))
vi.mock('../../api/http', () => ({ wsConnected: { __v_isRef: true, value: true } }))
vi.mock('vue-router', () => ({ useRoute: () => ({ fullPath: '/chat/c-9' }) }))

function message(id: string, role: 'user' | 'assistant', content: string, createdAt: number): DisplayMessage {
  return { id, role, content, createdAt } as DisplayMessage
}

function mountPanel(searchRequest: { id: number; messageId: string; query: string }) {
  return shallowMount(ChatPanel, {
    attachTo: document.body,
    props: { searchOpen: true, searchRequest },
    global: { stubs: { RouterLink: { name: 'RouterLink', props: ['to'], template: '<a><slot /></a>' } } },
  })
}

function highlighted(wrapper: ReturnType<typeof mountPanel>): string[] {
  return wrapper.findAll('[data-chat-search-message-id].ring-1').map((node) => node.attributes('data-chat-search-message-id')!)
}

describe('chat search requests', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    mocks.chat.messages = [
      message('m-1', 'user', 'How do I deploy with docker?', 1),
      message('m-2', 'assistant', 'Use docker compose up', 2),
      message('m-3', 'user', 'Thanks, docker works now', 3),
    ]
  })

  test('prefills the query and selects the requested match', async () => {
    const wrapper = mountPanel({ id: 1, messageId: 'm-2', query: 'docker' })
    await nextTick()
    await nextTick()

    expect((wrapper.get('input[type="search"]').element as HTMLInputElement).value).toBe('docker')
    expect(wrapper.text()).toContain('2 of 3')
    expect(highlighted(wrapper)).toEqual(['m-2'])
    wrapper.unmount()
  })

  test('highlights the requested message when the in-chat query does not match it', async () => {
    const wrapper = mountPanel({ id: 2, messageId: 'm-1', query: '"deploy" docker' })
    await nextTick()
    await nextTick()

    expect((wrapper.get('input[type="search"]').element as HTMLInputElement).value).toBe('deploy docker')
    expect(wrapper.text()).toContain('No results')
    expect(highlighted(wrapper)).toEqual(['m-1'])
    wrapper.unmount()
  })
})
