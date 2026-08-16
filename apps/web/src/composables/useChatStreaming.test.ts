import { describe, expect, test, vi } from 'vitest'
import { ref } from 'vue'
import type { DisplayMessage } from '../stores/chat.store'

vi.mock('../api/client', () => ({
  api: { chat: { markConversationRead: vi.fn().mockResolvedValue(undefined) } },
}))

import { useChatStreaming } from './useChatStreaming'

function setup() {
  const activeConversationId = ref<string | null>('conversation')
  const messages = ref<DisplayMessage[]>([])
  const conversations = ref([{ id: 'conversation', title: 'Conversation' }])
  const contextWindow = ref<number | null>(null)
  const streaming = useChatStreaming(activeConversationId, messages, conversations, contextWindow)

  return { messages, streaming }
}

describe('chat streaming completion', () => {
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
