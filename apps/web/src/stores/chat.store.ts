import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref, computed, watch } from 'vue'
import { api } from '../api/client'
import type { MemorySpace, StoredMessage } from '../api/types'
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
  audioDataUrls?: string[]
  fileAttachments?: { name: string }[]
  agentId?: string
  agentName?: string
  agentIconUrl?: string | null
  provider?: string
  model?: string
  promptTokens?: number
  completionTokens?: number
  contextTokens?: number
  latencyMs?: number
  createdAt: number
  isStreaming?: boolean
  isError?: boolean
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
  const modelModalities = ref<{ input: string[]; output: string[] } | null>(null)
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
  const isConversationLocked = computed(() => {
    const convId = activeConversationId.value
    return streaming.isStreaming.value ||
      activePostActions.value.size > 0 ||
      (Boolean(convId) && (agentStore.isExecuting || agentStore.awaitingHITLConvIds.has(convId!)))
  })

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
    if (agentIdHint !== undefined) {
      agentConfig.setConversationAgent(agentIdHint)
    }
    loadingMessages.value = true
    try {
      const response = await api.chat.getMessages(id)
      const rows = response.messages
      const lastContextTokens = response.lastContextTokens
      const COMPACT_EVENT_PREFIX = '[CONTEXT_COMPACT_EVENT] '
      messages.value = rows.map((r: StoredMessage) => {
        const base: DisplayMessage = {
          id: r.id,
          role: r.role as DisplayMessage['role'],
          content: r.content,
          thinking: r.thinking || undefined,
          imageDataUrls: r.imageDataUrls || undefined,
          audioDataUrls: r.audioDataUrls || undefined,
          fileAttachments: r.fileAttachments || undefined,
          agentId: r.agentId || undefined,
          agentName: r.agentName || undefined,
          agentIconUrl: r.agentIconUrl ?? undefined,
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
        streaming.primaryStreamId.value = buf.streamId
        streaming.streamingContent.value = buf.content
        streaming.streamingThinking.value = buf.thinking
        messages.value.push({
          id: `streaming_${Date.now()}`,
          role: 'assistant',
          content: buf.content,
          thinking: buf.thinking || undefined,
          imageDataUrls: buf.images.length ? buf.images : undefined,
          agentId: buf.agentId,
          agentName: buf.agentName,
          agentIconUrl: buf.agentIconUrl,
          createdAt: buf.createdAt,
          isStreaming: true
        })
      } else {
        streaming.isStreaming.value = false
        streaming.currentStreamId.value = null
        streaming.primaryStreamId.value = null
        streaming.streamingContent.value = ''
        streaming.streamingThinking.value = ''
      }

      // Restore context usage from DB-persisted last_context_tokens (updated mid-execution),
      // falling back to per-message token data for completed executions.
      restoreContextUsage(lastContextTokens)

      // Restore execution steps so tool calls render as grouped cards
      await agentStore.restoreForConversation(id)

      // If we navigated into a conversation after its websocket start events
      // already fired, hydrate the lock state from the server-side instance list.
      try {
        const instances = await api.instances.list()
        const activeInstance = instances.find((instance) => instance.conversationId === id)
        agentStore.setConversationExecutionState(id, Boolean(activeInstance))
      } catch {
        // Non-critical; live websocket events will still update state.
      }

      // Restore the full session config snapshot.
      // Legacy conversations without config_json fall back to agent defaults.
      const cfg = response.chatConfig
      if (cfg) {
        const activeAgent = agentDefs.get(agentConfig.activeAgentId.value || '')
        agentStore.selectedToolNames = cfg.allowedTools?.length ? [...cfg.allowedTools] : []
        agentConfig.freeChatSubAgentIds.value = cfg.subAgents?.length
          ? cfg.subAgents.map((s: { agentId: string }) => s.agentId)
          : []
        const hasMemorySpaceSnapshot = Object.prototype.hasOwnProperty.call(cfg, 'memorySpaceIds')
        agentConfig.freeChatMemorySpaceIds.value = Array.isArray(cfg.memorySpaceIds) ? [...cfg.memorySpaceIds] : []
        agentConfig.freeChatMemorySelectionInitialized.value = hasMemorySpaceSnapshot
        agentConfig.freeChatSkillIds.value = cfg.selectedSkillIds?.length ? [...cfg.selectedSkillIds] : []
        agentConfig.sessionSystemPrompt.value = cfg.systemPrompt ?? ''
        agentConfig.sessionThinkingEnabled.value = cfg.thinkingEnabled ?? true
        const restoredModel = cfg.model || null
        const restoredProviderId = cfg.providerId || null
        const matchesAgentModel = Boolean(activeAgent) &&
          (restoredModel === (activeAgent?.model || null)) &&
          (restoredProviderId === (activeAgent?.providerId || null))
        agentConfig.sessionModelOverride.value = matchesAgentModel ? null : restoredModel
        agentConfig.sessionProviderOverride.value = matchesAgentModel ? null : restoredProviderId
        agentConfig.sessionAutoToolRouting.value = cfg.autoToolRouting ?? !agentConfig.activeAgentId.value
        agentConfig.sessionAutoMemory.value = cfg.autoMemory ?? (activeAgent?.autoMemory === true)
        agentConfig.sessionAutoSkillRouting.value = cfg.autoSkillRouting ?? (activeAgent?.autoSkillRouting !== false)
        if (!agentConfig.activeAgentId.value) agentConfig.captureFreeChatPreset()
      } else {
        agentConfig.syncAgentBaseline()
      }
    } finally {
      if (activeConversationId.value === id) markConversationRead(id)
      loadingMessages.value = false
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
    api.provider.getModelInfo(providerId, model)
      .then(info => {
        if (info.contextLength) {
          contextWindow.value = info.contextLength
        } else {
          contextWindow.value = null
        }
        modelCost.value = info.cost ?? null
        modelModalities.value = (info.inputModalities?.length || info.outputModalities?.length)
          ? {
              input: info.inputModalities ?? [],
              output: info.outputModalities ?? []
            }
          : null
      })
      .catch(() => {
        contextWindow.value = null
        modelCost.value = null
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
      contextWindow.value = null
      modelCost.value = null
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
    agentStore.clearOrchestrationState()
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
      // Re-sort: pinned first, then by updatedAt desc
      conversations.value.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return b.updatedAt - a.updatedAt
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
      return b.updatedAt - a.updatedAt
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
    modelModalities,
    handleStreamStart: streaming.handleStreamStart,
    handleStreamChunk: streaming.handleStreamChunk,
    handleStreamThinking: streaming.handleStreamThinking,
    handleStreamImages: streaming.handleStreamImages,
    handleStreamReset: streaming.handleStreamReset,
    handleStreamUsage: streaming.handleStreamUsage,
    finalizeCurrentStreaming: streaming.finalizeCurrentStreaming,
    handleStreamEnd: streaming.handleStreamEnd,
    handleStreamError: streaming.handleStreamError,
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
    cancelStream: chatMessages.cancelStream,
    cancelPostActions: chatMessages.cancelPostActions,

    // Agent config (delegated)
    activeAgentId: agentConfig.activeAgentId,
    sessionModelOverride: agentConfig.sessionModelOverride,
    sessionProviderOverride: agentConfig.sessionProviderOverride,
    sessionSystemPrompt: agentConfig.sessionSystemPrompt,
    sessionThinkingEnabled: agentConfig.sessionThinkingEnabled,
    sessionAutoToolRouting: agentConfig.sessionAutoToolRouting,
    sessionAutoMemory: agentConfig.sessionAutoMemory,
    sessionAutoSkillRouting: agentConfig.sessionAutoSkillRouting,
    agentOriginalSystemPrompt: agentConfig.agentOriginalSystemPrompt,
    freeChatSubAgentIds: agentConfig.freeChatSubAgentIds,
    freeChatMemorySpaceIds: agentConfig.freeChatMemorySpaceIds,
    freeChatMemorySelectionInitialized: agentConfig.freeChatMemorySelectionInitialized,
    freeChatSkillIds: agentConfig.freeChatSkillIds,
    agentOriginalTools: agentConfig.agentOriginalTools,
    agentOriginalSubAgentIds: agentConfig.agentOriginalSubAgentIds,
    agentOriginalMemorySpaceIds: agentConfig.agentOriginalMemorySpaceIds,
    agentOriginalSkillIds: agentConfig.agentOriginalSkillIds,
    hasAgentOverrides: agentConfig.hasAgentOverrides,
    hasFreeChatOverrides: agentConfig.hasFreeChatOverrides,
    markOverridesModified: agentConfig.markOverridesModified,
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
