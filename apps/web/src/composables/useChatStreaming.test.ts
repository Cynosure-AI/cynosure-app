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

  return { messages, streaming }
}

describe('chat streaming completion', () => {
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
})
