import { describe, expect, test, vi } from 'vitest'
import { computed, ref } from 'vue'
import type { DisplayMessage } from '../stores/chat.store'

vi.mock('../api/client', () => ({
  api: { chat: { markConversationRead: vi.fn().mockResolvedValue(undefined) } },
}))

import { useChatStreaming } from './useChatStreaming'

function setup(activeId = 'conversation') {
  const activeConversationId = ref<string | null>(activeId)
  const messages = ref<DisplayMessage[]>([])
  const conversations = ref([{ id: 'conversation', title: 'Conversation' }])
  const contextWindow = ref<number | null>(null)
  const streaming = useChatStreaming(activeConversationId, messages, conversations, contextWindow)

  return { activeConversationId, messages, streaming }
}

describe('chat streaming completion', () => {
  test('keeps sub-agent usage out of the main context ring', () => {
    const { streaming } = setup()
    streaming.handleStreamUsage({
      conversationId: 'conversation', scope: 'main',
      usage: { promptTokens: 200, completionTokens: 50, totalTokens: 250 },
      contextTokens: 250, contextWindow: 1000,
    })
    streaming.handleStreamUsage({
      conversationId: 'conversation', scope: 'subagent',
      usage: { promptTokens: 500, completionTokens: 100, totalTokens: 600 },
      contextTokens: 600, contextWindow: 2000,
    })

    expect(streaming.lastUsage.value?.contextTokens).toBe(250)
    expect(streaming.subAgentUsage.value?.totalTokens).toBe(600)
  })

  test('keeps the visible conversation identity when a cron stream runs concurrently', () => {
    const { messages, streaming } = setup('chat-conversation')

    // A subscribed background run starts first and must remain buffer-only.
    streaming.handleStreamStart({
      streamId: 'cron-stream',
      conversationId: 'cron-conversation',
      agentId: 'housekeeper',
      agentName: 'Entity Housekeeper',
    })
    streaming.handleStreamStart({
      streamId: 'chat-stream',
      conversationId: 'chat-conversation',
      agentId: 'chat-agent',
      agentName: 'Cyno Chat',
    })

    // Tool use completes the first round. The reset creates the message that
    // receives the final answer and previously copied the cron agent identity.
    streaming.handleStreamChunk({
      streamId: 'chat-stream',
      conversationId: 'chat-conversation',
      content: 'Calling tools',
    })
    streaming.handleStreamReset({ streamId: 'chat-stream', conversationId: 'chat-conversation' })
    streaming.handleStreamChunk({
      streamId: 'chat-stream',
      conversationId: 'chat-conversation',
      content: 'Correct conversation output',
    })

    expect(messages.value.at(-1)).toMatchObject({
      content: 'Correct conversation output',
      agentId: 'chat-agent',
      agentName: 'Cyno Chat',
    })
    expect(messages.value.at(-1)?.agentName).not.toBe('Entity Housekeeper')
  })

  test('ignores late events from an older stream in the same conversation', () => {
    const { messages, streaming } = setup()

    streaming.handleStreamStart({ streamId: 'old-stream', conversationId: 'conversation' })
    streaming.handleStreamStart({ streamId: 'current-stream', conversationId: 'conversation' })
    streaming.handleStreamChunk({
      streamId: 'old-stream',
      conversationId: 'conversation',
      content: 'stale',
    })
    streaming.handleStreamEnd({ streamId: 'old-stream', conversationId: 'conversation' })
    streaming.handleStreamChunk({
      streamId: 'current-stream',
      conversationId: 'conversation',
      content: 'current',
    })

    expect(streaming.streamBuffers.get('conversation')).toMatchObject({
      streamId: 'current-stream',
      content: 'current',
      active: true,
    })
    expect(messages.value.at(-1)).toMatchObject({
      streamId: 'current-stream',
      content: 'current',
      isStreaming: true,
    })
  })

  test('invalidates active stream state when a stream finishes', () => {
    const { messages, streaming } = setup()
    const isActiveConversationStreaming = computed(() => {
      if (streaming.streamBuffers.get('conversation')?.active) return true
      return streaming.isStreaming.value && messages.value.some((message) => message.isStreaming)
    })

    expect(isActiveConversationStreaming.value).toBe(false)

    streaming.handleStreamStart({ streamId: 'stream', conversationId: 'conversation' })
    expect(isActiveConversationStreaming.value).toBe(true)

    streaming.handleStreamEnd({ streamId: 'stream', conversationId: 'conversation' })
    expect(isActiveConversationStreaming.value).toBe(false)
  })

  test('removes an empty placeholder after a tool-only continuation finishes', () => {
    const { messages, streaming } = setup()

    streaming.handleStreamStart({ streamId: 'stream', conversationId: 'conversation' })
    streaming.handleStreamReset({ streamId: 'stream', conversationId: 'conversation' })
    streaming.handleStreamEnd({ streamId: 'stream', conversationId: 'conversation' })

    expect(messages.value).toEqual([])
  })

  test('keeps visible model output when the stream finishes', () => {
    const { messages, streaming } = setup()

    streaming.handleStreamStart({ streamId: 'stream', conversationId: 'conversation' })
    streaming.handleStreamChunk({ streamId: 'stream', conversationId: 'conversation', content: 'Done.' })
    streaming.handleStreamEnd({
      streamId: 'stream',
      conversationId: 'conversation',
      model: 'test-model',
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    })

    expect(messages.value).toHaveLength(1)
    expect(messages.value[0]).toMatchObject({
      content: 'Done.',
      isStreaming: false,
      model: 'test-model',
      promptTokens: 10,
      completionTokens: 2,
    })
  })

  test('shows an explicit stream error even after an empty placeholder was removed', () => {
    const { messages, streaming } = setup()

    streaming.handleStreamStart({ streamId: 'stream', conversationId: 'conversation' })
    streaming.handleStreamEnd({ streamId: 'stream', conversationId: 'conversation' })
    streaming.handleStreamError({
      streamId: 'stream',
      conversationId: 'conversation',
      error: 'Provider connection failed.',
    })

    expect(messages.value).toHaveLength(1)
    expect(messages.value[0]).toMatchObject({
      content: 'Provider connection failed.',
      isError: true,
    })
  })

  test('uses a persisted error message without leaving a duplicate stream placeholder', () => {
    const { messages, streaming } = setup()
    streaming.handleStreamStart({ streamId: 'stream', conversationId: 'conversation' })
    streaming.handleStreamChunk({ streamId: 'stream', conversationId: 'conversation', content: 'Generating image...' })
    streaming.handleNewMessage({ streamId: 'stream', conversationId: 'conversation', message: {
      id: 'saved-error', conversationId: 'conversation', role: 'assistant',
      content: 'Generated image rejected by content moderation.', isError: true, createdAt: 2,
    } })
    streaming.handleStreamError({
      streamId: 'stream', conversationId: 'conversation',
      error: 'Generated image rejected by content moderation.',
    })
    expect(messages.value).toMatchObject([{
      id: 'saved-error', content: 'Generated image rejected by content moderation.', isError: true,
    }])
  })
})


describe('persisted streaming message identities', () => {
  test.each(['main', 'subagent'] as const)('joins a %s reply already present in loaded history to its completed stream', (scope) => {
    const { messages, streaming } = setup()
    const event = { conversationId: 'conversation', streamId: 'stream', sequence: 7 }
    messages.value.push({ id: 'saved-final', role: 'assistant', streamId: 'stream',
      sequence: 10, content: 'Answer', model: 'saved-model', createdAt: 10 })
    if (scope === 'main') {
      streaming.handleStreamStart(event)
      streaming.handleStreamChunk({ ...event, content: 'Answer' })
      streaming.handleStreamEnd(event)
    } else {
      streaming.handleSubAgentStreamStart(event)
      streaming.handleSubAgentStreamChunk({ ...event, content: 'Answer' })
      streaming.handleSubAgentStreamEnd(event)
    }
    const saved = { ...event, message: { id: 'saved-final', conversationId: 'conversation',
      role: 'assistant', sequence: 10, content: 'Answer', createdAt: 10 } }
    streaming.handleNewMessage(saved)
    streaming.handleNewMessage(saved)
    expect(messages.value).toHaveLength(1)
    expect(messages.value[0]).toMatchObject({ id: 'saved-final', content: 'Answer', model: 'saved-model', isStreaming: false })
  })

  test('does not join a saved earlier tool round to a newer streaming round', () => {
    const { messages, streaming } = setup()
    const event = { conversationId: 'conversation', streamId: 'stream' }
    messages.value.push({ id: 'saved-first', role: 'assistant', streamId: 'stream',
      sequence: 3, content: 'Checking tools', createdAt: 3 })
    streaming.handleStreamStart({ ...event, sequence: 7 })
    streaming.handleStreamChunk({ ...event, content: 'Answer' })
    streaming.handleNewMessage({ ...event, message: { id: 'saved-first', conversationId: 'conversation',
      role: 'assistant', sequence: 3, content: 'Checking tools', createdAt: 3 } })
    expect(messages.value.map(message => message.content)).toEqual(['Checking tools', 'Answer'])
    expect(messages.value[1].isStreaming).toBe(true)
  })

  test.each(['main', 'subagent'] as const)('keeps %s stream tracking when history arrives after the temporary reply', (scope) => {
    const { messages, streaming } = setup()
    const event = { conversationId: 'conversation', streamId: 'stream', sequence: 7 }
    if (scope === 'main') {
      streaming.handleStreamStart(event)
      streaming.handleStreamChunk({ ...event, content: 'Answer' })
    } else {
      streaming.handleSubAgentStreamStart(event)
      streaming.handleSubAgentStreamChunk({ ...event, content: 'Answer' })
    }
    messages.value.push({ id: 'saved-final', role: 'assistant', streamId: 'stream',
      sequence: 10, content: 'Answer', createdAt: 10 })
    streaming.handleNewMessage({ ...event, message: { id: 'saved-final', conversationId: 'conversation',
      role: 'assistant', sequence: 10, content: 'Answer', createdAt: 10 } })
    expect(messages.value).toHaveLength(1)
    expect(messages.value[0].isStreaming).toBe(true)
    if (scope === 'main') streaming.handleStreamEnd({ ...event, model: 'final-model' })
    else streaming.handleSubAgentStreamEnd({ ...event, model: 'final-model' })
    expect(messages.value[0]).toMatchObject({ id: 'saved-final', model: 'final-model', isStreaming: false })
  })

  test('hydrates clickable attachment links onto an optimistic user message', () => {
    const { messages, streaming } = setup()
    messages.value.push({
      id: 'user-message',
      role: 'user',
      content: 'Review this.',
      fileAttachments: [{ name: 'brief.pdf' }],
      createdAt: 1,
    })

    streaming.handleNewMessage({
      conversationId: 'conversation',
      message: {
        id: 'user-message',
        conversationId: 'conversation',
        role: 'user',
        content: 'Review this.',
        fileAttachments: [{ name: 'brief.pdf', href: '/api/files?path=brief.pdf' }],
        createdAt: 1,
      },
    })

    expect(messages.value).toHaveLength(1)
    expect(messages.value[0].fileAttachments).toEqual([
      { name: 'brief.pdf', href: '/api/files?path=brief.pdf' },
    ])
  })

  test('assigns database IDs to tool rounds and the final reply without duplicate bubbles', () => {
    const { messages, streaming } = setup()
    const event = { conversationId: 'conversation', streamId: 'stream' }
    streaming.handleStreamStart(event)
    streaming.handleStreamChunk({ ...event, content: 'Checking tools' })
    streaming.handleNewMessage({ ...event, message: { id: 'saved-round', conversationId: 'conversation', role: 'assistant', content: 'Checking tools', toolCallIds: ['call-1'], createdAt: 1 } })
    streaming.handleStreamReset(event)
    streaming.handleStreamChunk({ ...event, content: 'Answer' })
    streaming.handleStreamEnd(event)
    streaming.handleNewMessage({ ...event, message: { id: 'saved-final', conversationId: 'conversation', role: 'assistant', content: 'Answer', createdAt: 2 } })
    expect(messages.value.map(m => m.id)).toEqual(['saved-round', 'saved-final'])
    expect(messages.value.map(m => m.content)).toEqual(['Checking tools', 'Answer'])
    expect(messages.value[0].toolCallIds).toEqual(['call-1'])
  })

  test('assigns the saved ID to a completed sub-agent reply', () => {
    const { messages, streaming } = setup()
    const event = { conversationId: 'conversation', streamId: 'sub-stream', agentId: 'sub-agent' }
    streaming.handleSubAgentStreamStart(event)
    streaming.handleSubAgentStreamChunk({ ...event, content: 'Sub-agent answer' })
    streaming.handleSubAgentStreamEnd(event)
    const saved = { ...event, message: { id: 'saved-sub-agent', conversationId: 'conversation', role: 'assistant', content: 'Sub-agent answer', createdAt: 1 } }
    streaming.handleNewMessage(saved)
    streaming.handleNewMessage(saved)
    expect(messages.value).toHaveLength(1)
    expect(messages.value[0]).toMatchObject({ id: 'saved-sub-agent', content: 'Sub-agent answer', agentId: 'sub-agent', isStreaming: false })
  })

  test('ignores persisted IDs from another conversation', () => {
    const { messages, streaming } = setup()
    streaming.handleStreamStart({ conversationId: 'conversation', streamId: 'stream' })
    const originalId = messages.value[0].id
    streaming.handleNewMessage({ conversationId: 'other', streamId: 'stream', message: { id: 'other-id', conversationId: 'other', role: 'assistant', content: 'Other', createdAt: 1 } })
    expect(messages.value[0].id).toBe(originalId)
  })
})


describe('restoring a running conversation', () => {
  test('keeps earlier tool rounds intact when returning during a later round', () => {
    const { activeConversationId, messages, streaming } = setup()
    const event = { conversationId: 'conversation', streamId: 'stream' }
    streaming.handleStreamStart({ ...event, sequence: 1, createdAt: 1 })
    streaming.handleStreamChunk({ ...event, content: 'First tool round' })
    streaming.handleNewMessage({ ...event, message: {
      id: 'first', conversationId: 'conversation', role: 'assistant', content: 'First tool round', sequence: 3, createdAt: 3,
    } })
    activeConversationId.value = 'other'
    messages.value = []
    streaming.handleStreamReset({ ...event, sequence: 4, createdAt: 4 })
    streaming.handleStreamChunk({ ...event, content: 'Second tool round' })
    streaming.handleNewMessage({ ...event, message: {
      id: 'second', conversationId: 'conversation', role: 'assistant', content: 'Second tool round', sequence: 6, createdAt: 6,
    } })
    activeConversationId.value = 'conversation'
    messages.value = [
      { id: 'first', role: 'assistant', streamId: 'stream', content: 'First tool round', sequence: 3, createdAt: 3 },
      { id: 'second', role: 'assistant', streamId: 'stream', content: 'Second tool round', sequence: 6, createdAt: 6 },
    ]
    streaming.restorePrimaryStream('conversation')
    expect(messages.value.map(m => [m.id, m.content])).toEqual([
      ['first', 'First tool round'], ['second', 'Second tool round'],
    ])
    streaming.handleStreamReset({ ...event, sequence: 7, createdAt: 7 })
    streaming.handleStreamChunk({ ...event, content: 'Final answer' })
    streaming.handleStreamEnd(event)
    streaming.handleNewMessage({ ...event, message: {
      id: 'final', conversationId: 'conversation', role: 'assistant', content: 'Final answer', sequence: 10, createdAt: 10,
    } })
    expect(messages.value.map(m => [m.id, m.content])).toEqual([
      ['first', 'First tool round'], ['second', 'Second tool round'], ['final', 'Final answer'],
    ])
  })

  test.each(['text', 'thinking'])('creates a current round without overwriting saved messages during %s streaming', (kind) => {
    const { activeConversationId, messages, streaming } = setup('other')
    const event = { conversationId: 'conversation', streamId: 'stream' }
    streaming.handleStreamStart({ ...event, sequence: 1, createdAt: 1 })
    streaming.handleStreamReset({ ...event, sequence: 4, createdAt: 4 })
    if (kind === 'text') streaming.handleStreamChunk({ ...event, content: 'Partial answer' })
    else streaming.handleStreamThinking({ ...event, thinking: 'Still thinking' })
    activeConversationId.value = 'conversation'
    messages.value = [{ id: 'first', role: 'assistant', streamId: 'stream', content: 'First tool round', sequence: 3, createdAt: 3 }]
    streaming.restorePrimaryStream('conversation')
    streaming.restorePrimaryStream('conversation')
    expect(messages.value).toHaveLength(2)
    expect(messages.value[0]).toMatchObject({ id: 'first', content: 'First tool round' })
    expect(messages.value[0].isStreaming).toBeFalsy()
    expect(messages.value[1]).toMatchObject({ isStreaming: true, createdAt: 4,
      ...(kind === 'text' ? { content: 'Partial answer' } : { thinking: 'Still thinking' }),
    })
  })

  test('does not replace a saved earlier round when its stream has no current placeholder', () => {
    const { messages, streaming } = setup()
    messages.value = [{ id: 'first', role: 'assistant', streamId: 'stream', content: 'First tool round', createdAt: 1 }]
    streaming.handleNewMessage({ conversationId: 'conversation', streamId: 'stream', message: {
      id: 'second', conversationId: 'conversation', role: 'assistant', content: 'Second tool round', createdAt: 2,
    } })
    expect(messages.value.map(m => [m.id, m.content])).toEqual([
      ['first', 'First tool round'], ['second', 'Second tool round'],
    ])
  })
})
