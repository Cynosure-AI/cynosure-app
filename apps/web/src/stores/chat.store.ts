import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref, computed, watch } from 'vue'
import { api, type StoredMessage } from '../api/client'
import { useAgentStore } from './agent.store'
import { useAgentDefinitionsStore } from './agent-definitions.store'
import { useProviderStore } from './provider.store'
import { useChatStreaming } from '../composables/useChatStreaming'
import { useChatMessages } from '../composables/useChatMessages'
import { useChatAgentConfig } from '../composables/useChatAgentConfig'

export interface Conversation {
  id: string
  title: string
  origin?: string
  pinned: boolean
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
  const agentDefs = useAgentDefinitionsStore()
  const providerStore = useProviderStore()

  // ── Core state ──

  const conversations = ref<Conversation[]>([])
  const activeConversationId = ref<string | null>(null)
  const messages = ref<DisplayMessage[]>([])
  const contextWindow = ref<number | null>(null)
  const postActionsMap = new Map<string, Set<string>>()
  const postActionsTrigger = ref(0)
  const activePostActions = computed(() => {
    postActionsTrigger.value // track changes
    if (!activeConversationId.value) return new Set<string>()
    return postActionsMap.get(activeConversationId.value) || new Set<string>()
  })

  // ── Composables ──

  const streaming = useChatStreaming(activeConversationId, messages, conversations, contextWindow)

  async function loadConversations(): Promise<void> {
    const agentId = agentConfig.activeAgentId.value
    const rows = await api.chat.listConversations(agentId !== null ? agentId : '')
    conversations.value = rows.map(
      (r: { id: string; title: string; origin: string; pinned: number; created_at: number; updated_at: number }) => ({
        id: r.id,
        title: r.title,
        origin: r.origin,
        pinned: !!r.pinned,
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
      pinned: false,
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

    // Restore context usage from the last assistant message
    restoreContextUsage()
  }

  /**
   * Derive lastUsage from the most recent assistant message in the current conversation.
   */
  function restoreContextUsage(): void {
    const lastAssistant = [...messages.value].reverse().find(
      m => m.role === 'assistant' && m.promptTokens
    )
    if (lastAssistant?.promptTokens) {
      streaming.lastUsage.value = {
        promptTokens: lastAssistant.promptTokens,
        completionTokens: lastAssistant.completionTokens || 0,
        totalTokens: (lastAssistant.promptTokens || 0) + (lastAssistant.completionTokens || 0),
        model: lastAssistant.model
      }
    } else {
      streaming.lastUsage.value = null
    }
  }

  /** Fetch and update the context window for a given provider + model. */
  function fetchContextWindow(providerId: string, model: string): void {
    api.provider.getModelInfo(providerId, model)
      .then(info => {
        if (info.contextLength) {
          contextWindow.value = info.contextLength
        } else {
          contextWindow.value = null
        }
      })
      .catch(() => { contextWindow.value = null })
  }

  /**
   * Resolved provider + model for the current session.
   * Priority: session override > agent config > provider store defaults.
   */
  const resolvedModelProvider = computed(() => {
    // Session overrides take priority
    if (agentConfig.sessionModelOverride.value && agentConfig.sessionProviderOverride.value) {
      return {
        model: agentConfig.sessionModelOverride.value,
        providerId: agentConfig.sessionProviderOverride.value
      }
    }
    // Agent config
    if (agentConfig.activeAgentId.value) {
      const agent = agentDefs.get(agentConfig.activeAgentId.value)
      if (agent?.model && agent?.providerId) {
        return { model: agent.model, providerId: agent.providerId }
      }
    }
    // Provider store default
    const active = providerStore.activeProvider
    if (active) {
      return { model: active.defaultModel, providerId: active.id }
    }
    return null
  })

  // Watch resolved model/provider and auto-fetch context window
  watch(resolvedModelProvider, (resolved) => {
    if (resolved) {
      fetchContextWindow(resolved.providerId, resolved.model)
    } else {
      contextWindow.value = null
    }
  }, { immediate: true })

  async function deleteConversation(id: string): Promise<void> {
    const conv = conversations.value.find(c => c.id === id)
    if (conv?.pinned) return
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
    // Keep pinned conversations in the local list
    const pinned = conversations.value.filter(c => c.pinned)
    conversations.value = pinned
    if (pinned.length > 0) {
      activeConversationId.value = pinned[0].id
      await selectConversation(pinned[0].id)
    } else {
      activeConversationId.value = null
      messages.value = []
    }
    streaming.streamingContent.value = ''
    streaming.streamingThinking.value = ''
    streaming.isStreaming.value = false
    streaming.currentStreamId.value = null
    streaming.lastUsage.value = null
  }

  async function pinConversation(id: string, pinned: boolean): Promise<void> {
    await api.chat.pinConversation(id, pinned)
    const conv = conversations.value.find(c => c.id === id)
    if (conv) {
      conv.pinned = pinned
      // Re-sort: pinned first, then by updatedAt desc
      conversations.value.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return b.updatedAt - a.updatedAt
      })
    }
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
    contextWindow,
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
    fetchContextWindow,

    // Conversation CRUD
    loadConversations,
    createConversation,
    selectConversation,
    deleteConversation,
    deleteAllConversations,
    pinConversation,
    startNewChat,
    handlePostAction,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useChatStore, import.meta.hot))
}
