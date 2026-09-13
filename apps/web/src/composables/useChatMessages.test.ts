import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { ChatStreamingState } from './useChatStreaming'
import type { DisplayMessage } from '../stores/chat.store'
import type { ReasoningEffort } from '@shared/types'

const mocks = vi.hoisted(() => ({
  chat: {
    send: vi.fn(),
    getMessageAttachments: vi.fn(),
    truncateFrom: vi.fn(),
    cancelStream: vi.fn(),
    cancelPostActions: vi.fn(),
  },
  agentStore: {
    clearExecutionState: vi.fn(),
    setConversationExecutionState: vi.fn(),
    prepareConversationExecution: vi.fn(),
    stopConversationExecution: vi.fn(),
    reconcileStoppedExecution: vi.fn(),
    isConversationExecuting: vi.fn(() => false),
    truncateConversationExecution: vi.fn(),
    dismissHITLByConversation: vi.fn(),
  },
  agentDefinitions: {
    get: vi.fn(),
  },
  preferences: {
    generateTitle: true,
    contextStrategy: 'full',
    titleProviderId: '',
    titleModel: '',
    autoRouterProviderId: 'fallback-router-provider',
    autoRouterModel: 'fallback-router-model',
    compactProviderId: '',
    compactModel: '',
    inlineAttachmentTextLimit: 24_000,
  },
}))

vi.mock('../api/client', () => ({ api: { chat: mocks.chat } }))
vi.mock('../stores/agent-runtime.store', () => ({ useAgentStore: () => mocks.agentStore }))
vi.mock('../stores/agent-definitions.store', () => ({ useAgentDefinitionsStore: () => mocks.agentDefinitions }))
vi.mock('../stores/preferences.store', () => ({ usePreferencesStore: () => mocks.preferences }))

import { useChatMessages } from './useChatMessages'

function setup(initialConversationId: string | null = 'conversation') {
  const activeConversationId = ref<string | null>(initialConversationId)
  const activeAgentId = ref<string | null>('agent')
  const messages = ref<DisplayMessage[]>([])
  const streaming = {
    streamingContent: ref('old content'),
    streamingThinking: ref('old thinking'),
    isStreaming: ref(false),
    currentStreamId: ref<string | null>(null),
    primaryStreamId: ref<string | null>(null),
    primaryStreamAgent: ref({}),
    clearConversationStreamState: vi.fn(),
    findStreamingMsg: vi.fn(),
  } as unknown as ChatStreamingState
  const agentConfig = {
    sessionModelOverride: ref<string | null>('override-model'),
    sessionProviderOverride: ref<string | null>('override-provider'),
    sessionSystemPrompt: ref('Session prompt'),
    sessionThinkingEnabled: ref(false),
    sessionReasoningEffort: ref<ReasoningEffort>('high'),
    sessionAutoToolRouting: ref(true),
    sessionAutoMemory: ref(true),
    selectedToolNames: ref(['builtin::read']),
    freeChatSubAgentIds: ref(['sub-agent']),
    freeChatMemoryCategoryIds: ref(['memory-space']),
    freeChatMemorySelectionInitialized: ref(true),
  }
  const createConversation = vi.fn(async () => {
    activeConversationId.value = 'created-conversation'
    return 'created-conversation'
  })
  const api = useChatMessages(
    activeConversationId,
    activeAgentId,
    messages,
    streaming,
    createConversation,
    agentConfig,
  )
  return { api, activeConversationId, messages, streaming, createConversation, agentConfig }
}

describe('chat message actions', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mocks.agentStore.isConversationExecuting.mockReturnValue(false)
    mocks.agentDefinitions.get.mockReturnValue({
      name: 'Agent',
      iconUrl: '/agent.png',
      systemPrompt: 'Agent prompt',
      autoRouterProviderId: 'agent-router-provider',
      autoRouterModel: 'agent-router-model',
    })
    mocks.chat.send.mockResolvedValue(undefined)
    mocks.chat.getMessageAttachments.mockResolvedValue({})
    mocks.chat.truncateFrom.mockResolvedValue(undefined)
    mocks.chat.cancelStream.mockResolvedValue({ success: true, executionIds: [] })
    mocks.chat.cancelPostActions.mockResolvedValue(undefined)
  })

  test('creates a conversation, adds optimistic messages, and sends the complete run configuration', async () => {
    const state = setup(null)

    await state.api.sendMessage(
      'Hello',
      ['data:image/png;base64,image'],
      [{ name: 'notes.txt', content: 'notes' }],
      ['data:audio/wav;base64,audio'],
    )

    expect(state.createConversation).toHaveBeenCalledOnce()
    expect(state.messages.value).toHaveLength(2)
    expect(state.messages.value[0]).toMatchObject({
      role: 'user',
      content: 'Hello',
      fileAttachments: [{ name: 'notes.txt', href: expect.stringMatching(/^blob:/) }],
    })
    expect(state.messages.value[1]).toMatchObject({
      role: 'assistant',
      agentName: 'Agent',
      agentIconUrl: '/agent.png',
      isStreaming: true,
    })
    expect(mocks.chat.send).toHaveBeenCalledWith('created-conversation', expect.objectContaining({
      content: 'Hello',
      run: expect.objectContaining({
        model: 'override-model',
        providerOverride: 'override-provider',
        allowedTools: ['builtin::read'],
        systemPrompt: 'Session prompt',
        subAgents: [{ agentId: 'sub-agent' }],
        memoryCategoryIds: ['memory-space'],
        thinkingEnabled: false,
        reasoningEffort: 'high',
        autoToolRouting: true,
        autoMemory: true,
        autoRouterProviderId: 'agent-router-provider',
        autoRouterModel: 'agent-router-model',
        inlineAttachmentTextLimit: 24_000,
      }),
    }))
    expect(mocks.agentStore.setConversationExecutionState).toHaveBeenLastCalledWith('created-conversation', false)
  })

  test('does not send legacy global router preferences when the agent has no override', async () => {
    const state = setup()
    mocks.agentDefinitions.get.mockReturnValue({ id: 'agent', name: 'Agent', autoRouterProviderId: '', autoRouterModel: '' })
    await state.api.sendMessage('Hello')
    expect(mocks.chat.send).toHaveBeenCalledWith('conversation', expect.objectContaining({
      run: expect.objectContaining({ autoRouterProviderId: undefined, autoRouterModel: undefined }),
    }))
  })

  test('clears streaming state and rethrows when sending fails', async () => {
    const state = setup()
    mocks.chat.send.mockRejectedValue(new Error('server unavailable'))

    await expect(state.api.sendMessage('Hello')).rejects.toThrow('server unavailable')

    expect(state.streaming.clearConversationStreamState).toHaveBeenCalledWith('conversation')
    expect(mocks.agentStore.setConversationExecutionState).toHaveBeenLastCalledWith('conversation', false)
  })

  test('retries a user message by truncating later history and sending it again', async () => {
    const state = setup()
    mocks.chat.getMessageAttachments.mockResolvedValue({ imageDataUrls: ['image'] })
    state.messages.value = [
      { id: 'user', role: 'user', content: 'Try again', createdAt: 10, imageDataUrls: ['image'] },
      { id: 'assistant', role: 'assistant', content: 'Old answer', createdAt: 11 },
    ]

    await state.api.retryFromMessage('user')

    expect(mocks.chat.truncateFrom).toHaveBeenCalledWith('conversation', 'user')
    expect(mocks.chat.getMessageAttachments).toHaveBeenCalledWith('conversation', 'user')
    expect(mocks.agentStore.truncateConversationExecution).toHaveBeenCalledWith('conversation', 10)
    expect(mocks.chat.send).toHaveBeenCalledWith('conversation', expect.objectContaining({
      content: 'Try again',
      imageDataUrls: ['image'],
    }))
  })

  test('does not edit or retry while the conversation is running', async () => {
    const state = setup()
    state.messages.value = [{ id: 'user', role: 'user', content: 'Original', createdAt: 10 }]
    mocks.agentStore.isConversationExecuting.mockReturnValue(true)

    await state.api.retryFromMessage('user')
    await state.api.editMessage('user', 'Edited')

    expect(mocks.chat.truncateFrom).not.toHaveBeenCalled()
    expect(mocks.chat.send).not.toHaveBeenCalled()
  })

  test('edits a user message and rejects non-user or missing message ids', async () => {
    const state = setup()
    state.messages.value = [
      { id: 'user', role: 'user', content: 'Original', createdAt: 10 },
      { id: 'assistant', role: 'assistant', content: 'Answer', createdAt: 11 },
    ]

    await state.api.editMessage('assistant', 'Ignored')
    await state.api.editMessage('missing', 'Ignored')
    await state.api.editMessage('user', 'Edited')

    expect(mocks.chat.truncateFrom).toHaveBeenCalledOnce()
    expect(mocks.chat.send).toHaveBeenCalledWith('conversation', expect.objectContaining({ content: 'Edited' }))
  })

  test('resolves and preserves every attachment type before editing truncates history', async () => {
    const state = setup()
    state.messages.value = [
      {
        id: 'user',
        role: 'user',
        content: 'Original',
        imageDataUrls: ['/api/files?path=image'],
        audioDataUrls: ['/api/files?path=audio'],
        fileAttachments: [{ name: 'notes.txt' }],
        createdAt: 10,
      },
    ]
    mocks.chat.getMessageAttachments.mockResolvedValue({
      imageDataUrls: ['data:image/png;base64,image'],
      audioDataUrls: ['data:audio/wav;base64,audio'],
      files: [{ name: 'notes.txt', content: 'notes' }],
    })

    await state.api.editMessage('user', 'Edited')

    expect(mocks.chat.getMessageAttachments.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.chat.truncateFrom.mock.invocationCallOrder[0])
    expect(mocks.chat.send).toHaveBeenCalledWith('conversation', expect.objectContaining({
      content: 'Edited',
      imageDataUrls: ['data:image/png;base64,image'],
      audioDataUrls: ['data:audio/wav;base64,audio'],
      files: [{ name: 'notes.txt', content: 'notes' }],
    }))
  })

  test('latches local execution off immediately and reconciles server execution ids', async () => {
    const state = setup()
    state.streaming.primaryStreamId.value = 'stream'
    let resolveCancellation!: (result: { success: boolean; executionIds: string[] }) => void
    mocks.chat.cancelStream.mockReturnValueOnce(new Promise<{ success: boolean; executionIds: string[] }>((resolve) => {
      resolveCancellation = resolve
    }))

    const cancellation = state.api.cancelStream()

    expect(mocks.chat.cancelStream).toHaveBeenCalledWith('stream', 'conversation')
    expect(state.streaming.clearConversationStreamState).toHaveBeenCalledWith('conversation')
    expect(mocks.agentStore.stopConversationExecution).toHaveBeenCalledWith('conversation', ['stream'])

    resolveCancellation({ success: true, executionIds: ['stream', 'linked-stream'] })
    await cancellation

    expect(mocks.agentStore.reconcileStoppedExecution).toHaveBeenCalledWith('conversation', ['stream', 'linked-stream'])
    expect(mocks.chat.cancelPostActions).toHaveBeenCalledWith('conversation')
  })
})
