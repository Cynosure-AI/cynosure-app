import { beforeEach, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatEvent, ChatEventPayload, MessageItem } from '@shared/types'
import { api } from '../api/client'
import { useChatStore } from '../stores/chat.store'
import { useAgentStore } from '../stores/agent-runtime.store'
import { useChatEvents } from './useChatEvents'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.spyOn(api.chat, 'subscribeLiveConversations').mockImplementation(() => {})
  vi.spyOn(api.chat, 'markConversationRead').mockResolvedValue(undefined)
  vi.spyOn(api.chat, 'listConversations').mockResolvedValue([])
  vi.spyOn(api.chat, 'getPostActions').mockResolvedValue({ actions: [], quickResponses: { messageId: null, suggestions: [] } })
  vi.spyOn(api.chat, 'getQueue').mockResolvedValue({ conversationId: 'conversation', items: [], paused: false })
  vi.spyOn(api.chat, 'getEvents').mockResolvedValue({ events: [], latestSequence: 0 })
  vi.spyOn(api.instances, 'list').mockResolvedValue([])
  vi.spyOn(useAgentStore(), 'restoreForConversation').mockResolvedValue(undefined)
})

function listen() {
  let receive!: (event: ChatEvent) => void
  vi.spyOn(api.chat, 'onEvent').mockImplementation((callback) => {
    receive = callback
    return () => {}
  })
  const stop = useChatEvents()
  const emit = (sequence: number, payload: ChatEventPayload) => receive({
    ...payload, version: 1, conversationId: 'conversation', executionId: 'execution', sequence, createdAt: sequence,
  } as ChatEvent)
  return { stop, emit }
}

const message = (id: string, content: string, sequence: number): MessageItem => ({
  type: 'message', id, role: 'assistant', content: [{ type: 'text', text: content }],
  executionId: 'execution', sequence, createdAt: sequence,
})

test('opening an older cron chat does not replay its unsequenced saved final reply', () => {
  const store = useChatStore()
  store.activeConversationId = 'conversation'
  store.messages = [{ id: 'legacy-final', role: 'assistant', content: 'Housekeeping complete', createdAt: 10 }]
  const { emit, stop } = listen()
  try {
    emit(7, { type: 'stream-start', streamId: 'final-round', scope: 'main' })
    emit(8, { type: 'content-delta', streamId: 'final-round', scope: 'main', block: { type: 'text', text: 'Housekeeping complete' } })
    emit(9, { type: 'stream-end', streamId: 'final-round', scope: 'main' })
    expect(store.messages.map(item => item.content)).toEqual(['Housekeeping complete'])
    expect(store.isStreaming).toBe(false)
    // A subsequent run must remain visible even if its answer is identical.
    emit(11, { type: 'stream-start', streamId: 'next-run', scope: 'main' })
    emit(12, { type: 'content-delta', streamId: 'next-run', scope: 'main', block: { type: 'text', text: 'Housekeeping complete' } })
    emit(13, { type: 'stream-end', streamId: 'next-run', scope: 'main' })
    emit(14, { type: 'transcript-item', item: { ...message('next-final', 'Housekeeping complete', 14), executionId: 'next-run' } })
    expect(store.messages.map(item => item.id)).toEqual(['legacy-final', 'next-final'])
  } finally {
    stop()
  }
})

test('navigation restores distinct tool rounds and continues the current live reply', async () => {
  const store = useChatStore()
  store.activeConversationId = 'other'
  const { emit, stop } = listen()
  const first = message('first', 'First tool round', 3)
  const second = message('second', 'Second tool round', 6)
  emit(1, { type: 'stream-start', streamId: 'execution', scope: 'main' })
  emit(2, { type: 'content-delta', streamId: 'execution', scope: 'main', block: { type: 'text', text: 'First tool round' } })
  emit(3, { type: 'transcript-item', item: first })
  emit(4, { type: 'stream-reset', streamId: 'execution', scope: 'main' })
  emit(5, { type: 'content-delta', streamId: 'execution', scope: 'main', block: { type: 'text', text: 'Second tool round' } })
  emit(6, { type: 'transcript-item', item: second })
  emit(7, { type: 'stream-reset', streamId: 'execution', scope: 'main' })
  emit(8, { type: 'content-delta', streamId: 'execution', scope: 'main', block: { type: 'text', text: 'Final' } })
  vi.spyOn(api.chat, 'getMessages').mockResolvedValue({
    messages: [first, second], conversationAgentId: null, latestEventSequence: 6, lastContextTokens: null,
    executionConfig: {
      allowedTools: [], subAgents: [], memoryFolderIds: [], systemPrompt: '', model: '', providerId: '',
      thinkingEnabled: false, reasoningEffort: 'medium', autoToolRouting: false, autoMemory: false,
    },
  })
vi.mocked(api.instances.list).mockResolvedValue([{
    id: 'execution', type: 'chat', agentId: 'agent', agentName: 'Agent', agentIconUrl: null, model: null,
    conversationId: 'conversation', startedAt: 1, intervalMinutes: 0, status: 'running',
  }])
  try {
    await store.selectConversation('conversation')
    emit(9, { type: 'content-delta', streamId: 'execution', scope: 'main', block: { type: 'text', text: ' answer' } })
    emit(10, { type: 'stream-end', streamId: 'execution', scope: 'main' })
    emit(11, { type: 'transcript-item', item: message('final', 'Final answer', 11) })
    expect(store.messages.map(item => [item.id, item.content])).toEqual([
      ['first', 'First tool round'], ['second', 'Second tool round'], ['final', 'Final answer'],
    ])
  } finally {
    stop()
  }
})

test('joins a sub-agent tool-round transcript to its per-round stream', () => {
  const store = useChatStore()
  store.activeConversationId = 'conversation'
  const { emit, stop } = listen()
  try {
    emit(1, { type: 'stream-start', streamId: 'sub-round', scope: 'subagent', invocationId: 'worker' })
    emit(2, { type: 'content-delta', streamId: 'sub-round', scope: 'subagent', block: { type: 'text', text: 'Checking tools' } })
    emit(3, { type: 'stream-end', streamId: 'sub-round', scope: 'subagent' })
    emit(4, { type: 'transcript-item', item: {
      ...message('saved-sub-round', 'Checking tools', 4), executionId: 'sub-round', invocationId: 'worker',
    } })
    expect(store.messages.map(item => [item.id, item.content])).toEqual([['saved-sub-round', 'Checking tools']])
  } finally {
    stop()
  }
})
