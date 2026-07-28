import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref, computed, watch } from 'vue'
import { api } from '../api/client'
import type { MemorySpace, ModelPricing } from '../api/types'
import type { StoredMessageDto } from '@shared/types'
import { useAgentStore } from './agent-runtime.store'
import { useAgentDefinitionsStore } from './agent-definitions.store'
import { useProviderStore } from './provider.store'
import { useChatStreaming } from '../composables/useChatStreaming'
import { useChatMessages } from '../composables/useChatMessages'
import { useChatAgentConfig } from '../composables/useChatAgentConfig'

export interface Conversation {
  id: string
  title: string
  agentId?: string | null
  origin?: string
  pinned: boolean
  lastReadAt?: number | null
  createdAt: number
  updatedAt: number
}

export interface DisplayMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  thinking?: string
  imageDataUrls?: string[]
  videoDataUrls?: string[]
  audioDataUrls?: string[]
  fileAttachments?: { name: string }[]
  agentId?: string
  agentName?: string
  agentIconUrl?: string | null
  maCodename?: string
  maAgentName?: string
  maInvocationId?: string
  provider?: string
  model?: string
  promptTokens?: number
  completionTokens?: number
  contextTokens?: number
  latencyMs?: number
  createdAt: number
  isStreaming?: boolean
  isError?: boolean
  streamId?: string
  /** Set when this message is a compact event marker */
  compactEventData?: { summary: string; compactedMessageCount: number; model: string; createdAt: number }
}

export const useChatStore = defineStore('chat', () => {
  const agentStore = useAgentStore()
  const agentDefs = useAgentDefinitionsStore()
  const providerStore = useProviderStore()

  // ── Core state ──

  const conversations = ref<Conversation[]>([])
  const activeConversationId = ref<string | null>(null)
  const messages = ref<DisplayMessage[]>([])
  const loadingMessages = ref(false)
  const contextWindow = ref<number | null>(null)
  const modelCost = ref<{ input: number; output: number } | null>(null)
  const modelPricing = ref<ModelPricing | null>(null)
  const modelModalities = ref<{ input: string[]; output: string[] } | null>(null)
  let modelInfoRequestId = 0
  const memorySpaces = ref<MemorySpace[]>([])
  const postActionsMap = new Map<string, Set<string>>()
  const postActionsTrigger = ref(0)
  const activePostActions = computed(() => {
    void postActionsTrigger.value // track changes
    if (!activeConversationId.value) return new Set<string>()
    return postActionsMap.get(activeConversationId.value) || new Set<string>()
  })

  // ── Composables ──

  const streaming = useChatStreaming(activeConversationId, messages, conversations, contextWindow)
  const liveConversationSubscriptions = computed(() => {
    void postActionsTrigger.value // track active post-action map changes
    const ids = new Set<string>()
    if (activeConversationId.value) ids.add(activeConversationId.value)
    for (const conversationId of agentStore.liveExecutionConversationIds) {
      ids.add(conversationId)
    }
    for (const conversationId of postActionsMap.keys()) {
      ids.add(conversationId)
    }
    for (const [conversationId, buffer] of streaming.streamBuffers.entries()) {
      if (buffer.active) ids.add(conversationId)
    }
    for (const buffer of streaming.subAgentStreamBuffers.values()) {
      if (buffer.active) ids.add(buffer.conversationId)
    }
    return Array.from(ids)
  })

  watch(liveConversationSubscriptions, (conversationIds) => {
    api.chat.subscribeLiveConversations(conversationIds)
  }, { immediate: true })

  const activeConversationIsStreaming = computed(() => {
    const convId = activeConversationId.value
    if (!convId) return false
    if (streaming.streamBuffers.get(convId)?.active) return true
    return streaming.isStreaming.value && messages.value.some((message) => message.isStreaming)
  })
  const activeConversationHasRunningInstance = computed(() => {
    const convId = activeConversationId.value
    return Boolean(convId && (agentStore.isConversationExecuting(convId) || agentStore.awaitingHITLConvIds.has(convId)))
  })
  const isConversationLocked = computed(() => activeConversationHasRunningInstance.value)

  async function syncConversationRunState(conversationId: string): Promise<void> {
    try {
      const instances = await api.instances.list()
      if (activeConversationId.value !== conversationId) return
      const activeInstance = instances.find((instance) => instance.conversationId === conversationId)
      const isRunning = Boolean(activeInstance)
      agentStore.setConversationExecutionState(conversationId, isRunning)
      if (!isRunning) {
        streaming.clearConversationStreamState(conversationId)
      }
    } catch {
      // Non-critical; live websocket events and optimistic local state still keep the UI usable.
    }
  }

  async function loadConversations(): Promise<void> {
    const agentId = agentConfig.activeAgentId.value
    const rows = await api.chat.listConversations(agentId !== null ? agentId : '')
    conversations.value = rows.map(
      (r: { id: string; title: string; agent_id: string | null; origin: string; pinned: number; last_read_at: number | null; created_at: number; updated_at: number }) => ({
        id: r.id,
        title: r.title,
        agentId: r.agent_id,
        origin: r.origin,
        pinned: !!r.pinned,
        lastReadAt: r.last_read_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at
      })
    )
  }

  async function setActiveAgent(id: string | null): Promise<void> {
    if (!memorySpaces.value.length) await loadMemorySpaces()
    await agentConfig.setActiveAgent(id)
  }

  const agentConfig = useChatAgentConfig(activeConversationId, messages, conversations, loadConversations)

  async function loadMemorySpaces(): Promise<void> {
    try {
      const spaces = await api.memorySpaces.list()
      memorySpaces.value = [...spaces].sort((a, b) => {
        if (a.isDefault) return -1
        if (b.isDefault) return 1
        return (a.relativePath || '').localeCompare(b.relativePath || '')
      })
      agentConfig.setFreeChatDefaultMemorySpaceIds(memorySpaces.value.filter((space) => space.isDefault).map((space) => space.id))
    } catch {
      // Non-critical; memory selectors can retry later.
    }
  }

  async function createConversation(title?: string): Promise<string> {
    const conv = await api.chat.createConversation(
      title,
      agentConfig.activeAgentId.value ?? undefined
    )
    conversations.value.unshift({
      id: conv.id,
      title: conv.title,
      agentId: conv.agentId,
      origin: conv.origin,
      pinned: false,
      lastReadAt: conv.createdAt,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt
    })
    activeConversationId.value = conv.id
    messages.value = []
    agentStore.setActiveViewConversation(conv.id)
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

  async function sendMessage(...args: Parameters<typeof chatMessages.sendMessage>): Promise<void> {
    if (!memorySpaces.value.length) await loadMemorySpaces()
    agentConfig.ensureFreeChatPreset()
    const conversationId = activeConversationId.value
    await chatMessages.sendMessage(...args)
    const currentConversationId = activeConversationId.value
    if (currentConversationId && (!conversationId || currentConversationId === conversationId)) {
      markConversationRead(currentConversationId)
    }
  }

  // ── Conversation CRUD ──

  async function selectConversation(id: string, agentIdHint?: string | null): Promise<void> {
    activeConversationId.value = id
    agentStore.setActiveViewConversation(id)
    markConversationRead(id)
    loadingMessages.value = true
    try {
      const response = await api.chat.getMessages(id)
      if (activeConversationId.value !== id) return
      agentConfig.setConversationAgent(agentIdHint !== undefined ? agentIdHint : response.conversationAgentId)

      // Apply conversation-specific execution config immediately after setting
      // the agent, before any async work that could trigger a Vue render tick.
      // This prevents a flash where the agent defaults are briefly shown.
      const cfg = response.executionConfig
      agentConfig.restoreConversationConfig(cfg)

      const rows = response.messages
      const lastContextTokens = response.lastContextTokens
      const COMPACT_EVENT_PREFIX = '[CONTEXT_COMPACT_EVENT] '
      messages.value = rows.map((r: StoredMessageDto) => {
        const base: DisplayMessage = {
          id: r.id,
          role: r.role as DisplayMessage['role'],
          content: r.content,
          thinking: r.thinking || undefined,
          imageDataUrls: r.imageDataUrls || undefined,
          videoDataUrls: r.videoDataUrls || undefined,
          audioDataUrls: r.audioDataUrls || undefined,
          fileAttachments: r.fileAttachments || undefined,
          agentId: r.agentId || undefined,
          agentName: r.agentName || undefined,
          agentIconUrl: r.agentIconUrl ?? undefined,
          maCodename: r.maCodename || undefined,
          maAgentName: r.maAgentName || undefined,
          maInvocationId: r.maInvocationId || undefined,
          provider: r.provider || undefined,
          model: r.model || undefined,
          promptTokens: r.promptTokens || undefined,
          completionTokens: r.completionTokens || undefined,
          contextTokens: r.contextTokens || undefined,
          latencyMs: r.latencyMs || undefined,
          createdAt: r.createdAt
        }
        if (r.role === 'system' && r.content.startsWith(COMPACT_EVENT_PREFIX)) {
          try {
            base.compactEventData = JSON.parse(r.content.slice(COMPACT_EVENT_PREFIX.length))
          } catch { /* ignore */ }
        }
        return base
      })

      // Hydrate server-side post-action state
      try {
        const { actions } = await api.chat.getPostActions(id)
        if (activeConversationId.value !== id) return
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
      streaming.restorePrimaryStream(id)
      streaming.restoreSubAgentStreams(id)

      // Restore context usage from DB-persisted last_context_tokens (updated mid-execution),
      // falling back to per-message token data for completed executions.
      restoreContextUsage(lastContextTokens)

      // Restore execution steps so tool calls render as grouped cards
      await agentStore.restoreForConversation(id)
      if (activeConversationId.value !== id) return

      // If we navigated into a conversation after its websocket events already
      // fired, hydrate the run lock from the server-side instance list.
      await syncConversationRunState(id)
    } finally {
      if (activeConversationId.value === id) markConversationRead(id)
      if (activeConversationId.value === id) {
        loadingMessages.value = false
      }
    }
  }

  /**
   * Derive lastUsage from persisted token data.
   * @param lastContextTokens conversation-level last_context_tokens (persisted mid-execution)
   */
  function restoreContextUsage(lastContextTokens?: number | null): void {
    // Prefer conversation-level context tokens (updated every LLM round)
    if (lastContextTokens != null && lastContextTokens > 0) {
      // Find the last assistant message for model info
      const lastAssistant = [...messages.value].reverse().find(m => m.role === 'assistant')
      streaming.lastUsage.value = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: lastContextTokens,
        model: lastAssistant?.model,
        contextTokens: lastContextTokens,
      }
      return
    }

    // Fallback: derive from per-message token data
    const lastAssistant = [...messages.value].reverse().find(
      m => m.role === 'assistant' && m.promptTokens
    )
    if (lastAssistant?.promptTokens) {
      streaming.lastUsage.value = {
        promptTokens: lastAssistant.promptTokens,
        completionTokens: lastAssistant.completionTokens || 0,
        totalTokens: (lastAssistant.promptTokens || 0) + (lastAssistant.completionTokens || 0),
        model: lastAssistant.model,
        contextTokens: lastAssistant.contextTokens ?? ((lastAssistant.promptTokens || 0) + (lastAssistant.completionTokens || 0))
      }
    } else {
      streaming.lastUsage.value = null
    }
  }

  /** Fetch and update the context window for a given provider + model. */
  function fetchContextWindow(providerId: string, model: string): void {
    const requestId = ++modelInfoRequestId
    contextWindow.value = null
    modelCost.value = null
    modelPricing.value = null
    modelModalities.value = null

    api.provider.getModelInfo(providerId, model)
      .then(info => {
        if (requestId !== modelInfoRequestId) return
        if (info.contextLength) {
          contextWindow.value = info.contextLength
        } else {
          contextWindow.value = null
        }
        modelCost.value = info.cost ?? null
        modelPricing.value = info.pricing ?? null
        modelModalities.value = (info.inputModalities?.length || info.outputModalities?.length)
          ? {
            input: info.inputModalities ?? [],
            output: info.outputModalities ?? []
          }
          : null
      })
      .catch(() => {
        if (requestId !== modelInfoRequestId) return
        contextWindow.value = null
        modelCost.value = null
        modelPricing.value = null
        modelModalities.value = null
      })
  }

  /**
   * Resolved provider + model for the current session.
   * Priority: session override > agent config > provider store defaults.
   */
  const resolvedModelProvider = computed(() => {
    // Resolve base model + provider from agent config or provider store
    let model: string | undefined
    let providerId: string | undefined

    if (agentConfig.activeAgentId.value) {
      const agent = agentDefs.get(agentConfig.activeAgentId.value)
      if (agent?.model && agent?.providerId) {
        model = agent.model
        providerId = agent.providerId
      }
    }
    if (!model || !providerId) {
      const active = providerStore.lastUsedProvider
      if (active) {
        model = active.defaultModel
        providerId = active.id
      }
    }

    // Apply session overrides on top
    if (agentConfig.sessionProviderOverride.value) {
      providerId = agentConfig.sessionProviderOverride.value
    }
    if (agentConfig.sessionModelOverride.value) {
      model = agentConfig.sessionModelOverride.value
    }

    if (model && providerId) {
      return { model, providerId }
    }
    return null
  })

  // Watch resolved model/provider and auto-fetch context window
  watch(resolvedModelProvider, (resolved) => {
    if (resolved) {
      fetchContextWindow(resolved.providerId, resolved.model)
    } else {
      modelInfoRequestId++
      contextWindow.value = null
      modelCost.value = null
      modelPricing.value = null
      modelModalities.value = null
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

  function resetStreaming(): void {
    streaming.streamingContent.value = ''
    streaming.streamingThinking.value = ''
    streaming.isStreaming.value = false
    streaming.currentStreamId.value = null
    streaming.primaryStreamId.value = null
    streaming.lastUsage.value = null
  }

  async function startNewChat(): Promise<void> {
    if (!memorySpaces.value.length) await loadMemorySpaces()
    // New chat starts from the selected agent defaults, while free chat keeps its current preset.
    agentConfig.syncAgentBaseline()

    if (!activeConversationId.value && messages.value.length === 0) {
      return
    }

    activeConversationId.value = null
    messages.value = []
    agentStore.setActiveViewConversation(null)
    agentStore.clearExecutionState()
    agentStore.clearPlanningState()
    resetStreaming()
  }

  async function deleteAllConversations(allConversations = false): Promise<void> {
    await api.chat.deleteAllConversations(allConversations ? undefined : agentConfig.activeAgentId.value)
    // Keep pinned conversations in the local list
    const pinned = conversations.value.filter(c => c.pinned)
    conversations.value = pinned
    resetStreaming()
    if (pinned.length > 0) {
      activeConversationId.value = pinned[0].id
      await selectConversation(pinned[0].id)
    } else {
      activeConversationId.value = null
      agentStore.setActiveViewConversation(null)
      messages.value = []
    }
  }

  async function pinConversation(id: string, pinned: boolean): Promise<void> {
    await api.chat.pinConversation(id, pinned)
    const conv = conversations.value.find(c => c.id === id)
    if (conv) {
      conv.pinned = pinned
      // Re-sort: pinned first, then by creation date desc.
      conversations.value.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return b.createdAt - a.createdAt
      })
    }
  }

  async function renameConversation(id: string, title: string): Promise<void> {
    const trimmed = title.trim()
    if (!trimmed) return
    await api.chat.updateTitle(id, trimmed)
    const conv = conversations.value.find(c => c.id === id)
    if (conv) conv.title = trimmed
  }

  async function forkConversationFromMessage(messageId: string): Promise<void> {
    const sourceConversationId = activeConversationId.value
    if (!sourceConversationId || isConversationLocked.value) return
    const fork = await api.chat.forkConversation(sourceConversationId, messageId)
    conversations.value.unshift({
      id: fork.id,
      title: fork.title,
      agentId: fork.agentId,
      origin: fork.origin,
      pinned: false,
      lastReadAt: fork.createdAt,
      createdAt: fork.createdAt,
      updatedAt: fork.updatedAt
    })
    streaming.streamBuffers.delete(fork.id)
    await selectConversation(fork.id, fork.agentId)
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

  const sortedConversations = computed(() =>
    [...conversations.value].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return b.createdAt - a.createdAt
    })
  )

  const activeConversation = computed(() =>
    conversations.value.find((c) => c.id === activeConversationId.value)
  )

  /** A conversation is unread when it has been updated after the user last read it. */
  function isConversationUnread(conv: Conversation): boolean {
    if (conv.id === activeConversationId.value) return false
    return !conv.lastReadAt || conv.updatedAt > conv.lastReadAt
  }

  /** Mark one conversation as read locally and persist it best-effort. */
  function markConversationRead(id: string): void {
    const conv = conversations.value.find(c => c.id === id)
    if (conv) {
      conv.lastReadAt = Math.max(Date.now(), conv.updatedAt, conv.lastReadAt || 0)
    }
    api.chat.markConversationRead(id).catch(() => { /* non-critical */ })
  }

  /** Mark all conversations as read. */
  function markAllAsRead(): void {
    const now = Date.now()
    for (const conv of conversations.value) {
      conv.lastReadAt = Math.max(now, conv.updatedAt, conv.lastReadAt || 0)
      api.chat.markConversationRead(conv.id).catch(() => { /* non-critical */ })
    }
  }

  void loadMemorySpaces()

  return {
    // Core state
    conversations,
    sortedConversations,
    activeConversationId,
    messages,
    loadingMessages,
    memorySpaces,
    activeConversation,
    activePostActions,
    activeConversationIsStreaming,
    activeConversationHasRunningInstance,
    isConversationLocked,

    // Unread helpers
    isConversationUnread,
    markConversationRead,
    markAllAsRead,

    // Streaming (delegated)
    isStreaming: streaming.isStreaming,
    currentStreamId: streaming.currentStreamId,
    streamingContent: streaming.streamingContent,
    streamingThinking: streaming.streamingThinking,
    lastUsage: streaming.lastUsage,
    contextWindow,
    modelCost,
    modelPricing,
    modelModalities,
    handleStreamStart(data: { streamId: string; conversationId: string; agentId?: string; agentName?: string; agentIconUrl?: string | null; maCodename?: string; maAgentName?: string; maInvocationId?: string }): void {
      streaming.handleStreamStart(data)
      agentStore.setConversationExecutionState(data.conversationId, true)
    },
    handleStreamChunk: streaming.handleStreamChunk,
    handleStreamThinking: streaming.handleStreamThinking,
    handleStreamImages: streaming.handleStreamImages,
    handleStreamVideos: streaming.handleStreamVideos,
    handleStreamReset: streaming.handleStreamReset,
    handleStreamUsage: streaming.handleStreamUsage,
    finalizeCurrentStreaming: streaming.finalizeCurrentStreaming,
    handleStreamEnd(data: { streamId: string; conversationId: string; cancelled?: boolean; usage?: { promptTokens: number; completionTokens: number; totalTokens: number }; model?: string; contextWindow?: number; contextTokens?: number; images?: string[] }): void {
      streaming.handleStreamEnd(data)
      // Clear execution state when the stream ends — the task:completed WS event
      // may arrive later or not at all, so ensure the conversation unlocks promptly.
      agentStore.setConversationExecutionState(data.conversationId, false)
    },
    handleStreamError(data: { streamId: string; conversationId: string; error: string }): void {
      streaming.handleStreamError(data)
      agentStore.setConversationExecutionState(data.conversationId, false)
    },
    handleSubAgentStreamStart: streaming.handleSubAgentStreamStart,
    handleSubAgentStreamChunk: streaming.handleSubAgentStreamChunk,
    handleSubAgentStreamThinking: streaming.handleSubAgentStreamThinking,
    handleSubAgentStreamImages: streaming.handleSubAgentStreamImages,
    handleSubAgentStreamEnd: streaming.handleSubAgentStreamEnd,
    handleTitleUpdated: streaming.handleTitleUpdated,
    handleNewMessage: streaming.handleNewMessage,
    handleCompactEvent: streaming.handleCompactEvent,
    handleCompactStart: streaming.handleCompactStart,
    handleCompactError: streaming.handleCompactError,

    // Messages (delegated)
    sendMessage,
    retryFromMessage: chatMessages.retryFromMessage,
    editMessage: chatMessages.editMessage,
    forkConversationFromMessage,
    cancelStream(): void {
      chatMessages.cancelStream()
      // Ensure post-actions are cleared locally so the conversation unlocks.
      const id = activeConversationId.value
      if (id) {
        postActionsMap.delete(id)
        postActionsTrigger.value++
      }
    },
    cancelPostActions(convId?: string): void {
      const id = convId || activeConversationId.value
      if (id) {
        postActionsMap.delete(id)
        postActionsTrigger.value++
      }
      chatMessages.cancelPostActions(id || undefined)
    },

    // Agent config (delegated)
    activeAgentId: agentConfig.activeAgentId,
    sessionModelOverride: agentConfig.sessionModelOverride,
    sessionProviderOverride: agentConfig.sessionProviderOverride,
    sessionSystemPrompt: agentConfig.sessionSystemPrompt,
    sessionThinkingEnabled: agentConfig.sessionThinkingEnabled,
    sessionAutoToolRouting: agentConfig.sessionAutoToolRouting,
    sessionAutoMemory: agentConfig.sessionAutoMemory,
    selectedToolNames: agentConfig.selectedToolNames,
    agentOriginalSystemPrompt: agentConfig.agentOriginalSystemPrompt,
    freeChatSubAgentIds: agentConfig.freeChatSubAgentIds,
    freeChatMemorySpaceIds: agentConfig.freeChatMemorySpaceIds,
    freeChatMemorySelectionInitialized: agentConfig.freeChatMemorySelectionInitialized,
    agentOriginalTools: agentConfig.agentOriginalTools,
    agentOriginalSubAgentIds: agentConfig.agentOriginalSubAgentIds,
    agentOriginalMemorySpaceIds: agentConfig.agentOriginalMemorySpaceIds,
    hasAgentOverrides: agentConfig.hasAgentOverrides,
    hasFreeChatOverrides: agentConfig.hasFreeChatOverrides,
    markOverridesModified: agentConfig.markOverridesModified,
    setSelectedToolNames: agentConfig.setSelectedToolNames,
    resetAgentOverrides: agentConfig.resetAgentOverrides,
    resetToDefaults: agentConfig.resetToDefaults,
    applyOverridesToAgent: agentConfig.applyOverridesToAgent,
    setActiveAgent,
    setSessionModel: agentConfig.setSessionModel,
    syncAgentBaseline: agentConfig.syncAgentBaseline,
    loadMemorySpaces,
    fetchContextWindow,

    // Conversation CRUD
    loadConversations,
    createConversation,
    selectConversation,
    deleteConversation,
    deleteAllConversations,
    pinConversation,
    renameConversation,
    startNewChat,
    handlePostAction,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useChatStore, import.meta.hot))
}
