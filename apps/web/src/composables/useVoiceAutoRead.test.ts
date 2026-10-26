import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ChatEvent, VoiceAutoRead } from '@shared/types'

const mocks = vi.hoisted(() => ({
  chatStore: { activeConversationId: null as string | null },
  handler: null as ((event: ChatEvent) => void) | null,
  stream: { push: vi.fn(), reset: vi.fn(), end: vi.fn() },
  startStream: vi.fn(),
  stop: vi.fn(),
}))

vi.mock('../api/client', () => ({
  api: { chat: { onEvent: (handler: (event: ChatEvent) => void) => { mocks.handler = handler; return () => {} } } },
}))

vi.mock('../stores/chat.store', async () => {
  const { reactive } = await import('vue')
  const store = reactive(mocks.chatStore)
  return { useChatStore: () => store }
})

vi.mock('./useSpeechPlayer', () => ({
  useSpeechPlayer: () => ({ state: { phase: 'idle' }, startStream: mocks.startStream, stop: mocks.stop }),
}))

import { armVoiceReply, useVoiceAutoRead } from './useVoiceAutoRead'
import { useChatStore } from '../stores/chat.store'
import { useVoiceOutputStore } from '../stores/voice-output.store'

const base = { version: 1 as const, conversationId: 'c1', executionId: 'e1', sequence: 1, createdAt: 1 }

function emit(payload: Record<string, unknown>, executionId = 'e1'): void {
  mocks.handler!({ ...base, executionId, ...payload } as ChatEvent)
}

function setup(autoRead: VoiceAutoRead): () => void {
  useChatStore().activeConversationId = 'c1'
  useVoiceOutputStore().settings = { enabled: true, voiceId: 'en_GB-aru-medium', speakerId: 0, speed: 1, autoRead }
  return useVoiceAutoRead()
}

describe('useVoiceAutoRead', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mocks.startStream.mockReturnValue(mocks.stream)
  })

  test('reads the reply to a voice message while it streams, across rounds', () => {
    const cleanup = setup('voice')
    armVoiceReply('c1')

    emit({ type: 'stream-start', streamId: 's1', scope: 'main' })
    emit({ type: 'content-delta', streamId: 's1', scope: 'main', block: { type: 'reasoning', text: 'hmm' } })
    emit({ type: 'content-delta', streamId: 's1', scope: 'main', block: { type: 'text', text: 'Let me check.' } })
    emit({ type: 'content-delta', streamId: 'sub', scope: 'subagent', block: { type: 'text', text: 'Subagent text.' } })
    emit({ type: 'stream-start', streamId: 's2', scope: 'main' })
    emit({ type: 'content-delta', streamId: 's2', scope: 'main', block: { type: 'text', text: 'Done.' } })
    emit({ type: 'execution-state', agentId: null, state: 'finished' })

    expect(mocks.startStream).toHaveBeenCalledTimes(1)
    expect(mocks.stream.push.mock.calls).toEqual([['Let me check.'], ['Done.']])
    expect(mocks.stream.end).toHaveBeenCalledTimes(1)
    cleanup()
  })

  test('stays silent for typed messages unless set to always', () => {
    let cleanup = setup('voice')
    emit({ type: 'stream-start', streamId: 's1', scope: 'main' })
    expect(mocks.startStream).not.toHaveBeenCalled()
    cleanup()

    cleanup = setup('always')
    emit({ type: 'stream-start', streamId: 's1', scope: 'main' }, 'e2')
    expect(mocks.startStream).toHaveBeenCalledTimes(1)
    cleanup()
  })

  test('ignores replies in other chats and when turned off', () => {
    const cleanup = setup('off')
    armVoiceReply('c1')
    emit({ type: 'stream-start', streamId: 's1', scope: 'main' })
    expect(mocks.startStream).not.toHaveBeenCalled()

    useVoiceOutputStore().settings!.autoRead = 'always'
    mocks.handler!({ ...base, conversationId: 'other', type: 'stream-start', streamId: 's1', scope: 'main' } as ChatEvent)
    expect(mocks.startStream).not.toHaveBeenCalled()
    cleanup()
  })
})
