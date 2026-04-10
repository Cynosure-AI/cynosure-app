import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref, computed } from 'vue'
import { api, type StoredMessage } from '../api/client'
import { useAgentStore } from './agent.store'
import { useChatStreaming } from '../composables/useChatStreaming'
import { useChatMessages } from '../composables/useChatMessages'
import { useChatAgentConfig } from '../composables/useChatAgentConfig'

export interface Conversation {
  id: string
  title: string
  origin?: string
  createdAt: number
  updatedAt: number
}

export interface MemorySource {
  text: string
  source: string
  score: number
}

export interface DisplayMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  thinking?: string
  imageDataUrls?: string[]
  audioDataUrls?: string[]
  fileAttachments?: { name: string }[]
  memorySources?: MemorySource[]
  agentId?: string
  agentName?: string
  agentIconUrl?: string | null
  provider?: string
  model?: string
  promptTokens?: number
  completionTokens?: number
  latencyMs?: number
  createdAt: number
  isStreaming?: boolean
  isError?: boolean
}

export const useChatStore = defineStore('chat', () => {
  const agentStore = useAgentStore()

  // ── Core state ──

  const conversations = ref<Conversation[]>([])
  const activeConversationId = ref<string | null>(null)
  const messages = ref<DisplayMessage[]>([])
  const postActionsMap = new Map<string, Set<string>>()
  const postActionsTrigger = ref(0)
  const activePostActions = computed(() => {
    postActionsTrigger.value // track changes
    if (!activeConversationId.value) return new Set<string>()
    return postActionsMap.get(activeConversationId.value) || new Set<string>()
  })

  // ── Composables ──

  const streaming = useChatStreaming(activeConversationId, messages, conversations)

  async function loadConversations(): Promise<void> {
    const agentId = agentConfig.activeAgentId.value
    const rows = await api.chat.listConversations(agentId !== null ? agentId : '')
    conversations.value = rows.map(
      (r: { id: string; title: string; origin: string; created_at: number; updated_at: number }) => ({
        id: r.id,
        title: r.title,
        origin: r.origin,
        createdAt: r.created_at,
        updatedAt: r.updated_at
      })
    )
  }

  const agentConfig = useChatAgentConfig(activeConversationId, messages, conversations, loadConversations)

  async function createConversation(title?: string): Promise<string> {
    const conv = await api.chat.createConversation(
      title,
      agentConfig.activeAgentId.value ?? undefined
    )
    conversations.value.unshift({
      id: conv.id,
      title: conv.title,
      origin: conv.origin,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt
    })
    activeConversationId.value = conv.id
    messages.value = []
    agentStore.clearExecution()
    return conv.id
  }

  const chatMessages = useChatMessages(
    activeConversationId,
    agentConfig.activeAgentId,
    messages,
    streaming,
    createConversation,
    agentConfig,
  )

  // ── Conversation CRUD ──

  async function selectConversation(id: string): Promise<void> {
    activeConversationId.value = id
    const rows = await api.chat.getMessages(id)
    messages.value = rows.map((r: StoredMessage) => ({
      id: r.id,
      role: r.role as DisplayMessage['role'],
      content: r.content,
      thinking: r.thinking || undefined,
      imageDataUrls: r.imageDataUrls || undefined,
      audioDataUrls: r.audioDataUrls || undefined,
      fileAttachments: r.fileAttachments || undefined,
      memorySources: r.memorySources || undefined,
      agentId: r.agentId || undefined,
      agentName: r.agentName || undefined,
      agentIconUrl: r.agentIconUrl ?? undefined,
      provider: r.provider || undefined,
      model: r.model || undefined,
      promptTokens: r.promptTokens || undefined,
      completionTokens: r.completionTokens || undefined,
      latencyMs: r.latencyMs || undefined,
      createdAt: r.createdAt
    }))

    // Hydrate server-side post-action state
    try {
      const { actions } = await api.chat.getPostActions(id)
      if (actions.length) {
        postActionsMap.set(id, new Set(actions))
      } else {
        postActionsMap.delete(id)
      }
      postActionsTrigger.value++
    } catch {
      // Non-critical
    }

    // Restore streaming state if this conversation has an active stream
    const buf = streaming.streamBuffers.get(id)
    if (buf?.active) {
      streaming.isStreaming.value = true
      streaming.currentStreamId.value = buf.streamId
      streaming.streamingContent.value = buf.content
      streaming.streamingThinking.value = buf.thinking
      messages.value.push({
        id: `streaming_${Date.now()}`,
        role: 'assistant',
        content: buf.content,
        thinking: buf.thinking || undefined,
        agentId: buf.agentId,
        agentName: buf.agentName,
        agentIconUrl: buf.agentIconUrl,
        createdAt: buf.createdAt,
        isStreaming: true
      })
    } else {
      streaming.isStreaming.value = false
      streaming.currentStreamId.value = null
      streaming.streamingContent.value = ''
      streaming.streamingThinking.value = ''
    }
  }

  async function deleteConversation(id: string): Promise<void> {
    await api.chat.deleteConversation(id)
    conversations.value = conversations.value.filter((c) => c.id !== id)
    streaming.streamBuffers.delete(id)
    if (activeConversationId.value === id) {
      activeConversationId.value = conversations.value[0]?.id || null
      if (activeConversationId.value) {
        await selectConversation(activeConversationId.value)
      } else {
        messages.value = []
      }
    }
  }

  function startNewChat(): void {
    if (!activeConversationId.value && messages.value.length === 0) return

    activeConversationId.value = null
    messages.value = []
    streaming.streamingContent.value = ''
    streaming.streamingThinking.value = ''
    streaming.isStreaming.value = false
    streaming.currentStreamId.value = null
    streaming.lastUsage.value = null
    agentConfig.sessionModelOverride.value = null
    agentConfig.sessionProviderOverride.value = null
  }

  async function deleteAllConversations(): Promise<void> {
    await api.chat.deleteAllConversations(agentConfig.activeAgentId.value)
    conversations.value = []
    activeConversationId.value = null
    messages.value = []
    streaming.streamingContent.value = ''
    streaming.streamingThinking.value = ''
    streaming.isStreaming.value = false
    streaming.currentStreamId.value = null
    streaming.lastUsage.value = null
  }

  // ── Post-actions ──

  function handlePostAction(data: { conversationId: string; action: string; status: 'started' | 'completed' }): void {
    if (data.status === 'started') {
      let actions = postActionsMap.get(data.conversationId)
      if (!actions) {
        actions = new Set()
        postActionsMap.set(data.conversationId, actions)
      }
      actions.add(data.action)
    } else {
      const actions = postActionsMap.get(data.conversationId)
      if (actions) {
        actions.delete(data.action)
        if (actions.size === 0) postActionsMap.delete(data.conversationId)
      }
    }
    postActionsTrigger.value++
  }

  // ── Computed ──

  const activeConversation = computed(() =>
    conversations.value.find((c) => c.id === activeConversationId.value)
  )

  return {
    // Core state
    conversations,
    activeConversationId,
    messages,
    activeConversation,
    activePostActions,

    // Streaming (delegated)
    isStreaming: streaming.isStreaming,
    currentStreamId: streaming.currentStreamId,
    streamingContent: streaming.streamingContent,
    streamingThinking: streaming.streamingThinking,
    lastUsage: streaming.lastUsage,
    handleStreamStart: streaming.handleStreamStart,
    handleStreamChunk: streaming.handleStreamChunk,
    handleStreamThinking: streaming.handleStreamThinking,
    handleStreamImages: streaming.handleStreamImages,
    handleStreamReset: streaming.handleStreamReset,
    finalizeCurrentStreaming: streaming.finalizeCurrentStreaming,
    handleStreamEnd: streaming.handleStreamEnd,
    handleStreamError: streaming.handleStreamError,
    handleSubAgentStreamStart: streaming.handleSubAgentStreamStart,
    handleSubAgentStreamChunk: streaming.handleSubAgentStreamChunk,
    handleSubAgentStreamThinking: streaming.handleSubAgentStreamThinking,
    handleSubAgentStreamImages: streaming.handleSubAgentStreamImages,
    handleSubAgentStreamEnd: streaming.handleSubAgentStreamEnd,
    handleTitleUpdated: streaming.handleTitleUpdated,
    handleMemorySources: streaming.handleMemorySources,
    handleNewMessage: streaming.handleNewMessage,

    // Messages (delegated)
    sendMessage: chatMessages.sendMessage,
    retryFromMessage: chatMessages.retryFromMessage,
    editMessage: chatMessages.editMessage,
    cancelStream: chatMessages.cancelStream,
    cancelPostActions: chatMessages.cancelPostActions,

    // Agent config (delegated)
    activeAgentId: agentConfig.activeAgentId,
    sessionModelOverride: agentConfig.sessionModelOverride,
    sessionProviderOverride: agentConfig.sessionProviderOverride,
    freeChatSubAgentIds: agentConfig.freeChatSubAgentIds,
    freeChatMemorySpaceIds: agentConfig.freeChatMemorySpaceIds,
    agentOriginalTools: agentConfig.agentOriginalTools,
    agentOriginalSubAgentIds: agentConfig.agentOriginalSubAgentIds,
    agentOriginalMemorySpaceIds: agentConfig.agentOriginalMemorySpaceIds,
    hasAgentOverrides: agentConfig.hasAgentOverrides,
    markOverridesModified: agentConfig.markOverridesModified,
    resetAgentOverrides: agentConfig.resetAgentOverrides,
    applyOverridesToAgent: agentConfig.applyOverridesToAgent,
    setActiveAgent: agentConfig.setActiveAgent,
    setSessionModel: agentConfig.setSessionModel,
    syncAgentBaseline: agentConfig.syncAgentBaseline,

    // Conversation CRUD
    loadConversations,
    createConversation,
    selectConversation,
    deleteConversation,
    deleteAllConversations,
    startNewChat,
    handlePostAction,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useChatStore, import.meta.hot))
}
