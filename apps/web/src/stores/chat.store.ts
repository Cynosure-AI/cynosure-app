import { useAgentHealthStore } from './agent-health.store'
import { useCynoStore } from './cyno.store'
import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref, computed, watch } from 'vue'
import { api, type PendingWait } from '../api/client'
import type { ChatExecutionState, MemoryFolder, ModelPricing } from '../api/types'
import type { ChatQueueDelivery, MessageToolCall, ContextEvidence, MediaGenerationSettings, PermissionMode, QueuedChatMessageDto } from '@shared/types'
import { useAgentStore } from './agent-runtime.store'
import { useAgentDefinitionsStore } from './agent-definitions.store'
import { useProviderStore } from './provider.store'
import { useChatStreaming } from '../composables/useChatStreaming'
import { useChatMessages } from '../composables/useChatMessages'
import { useChatAgentConfig } from '../composables/useChatAgentConfig'
import { resolveEffectiveProviderModel } from '../utils/model-selection'
import { toDisplayMessage } from '../utils/message-view'

export interface Conversation {
  id: string
  title: string
  agentId?: string | null
  projectId?: string | null
  origin?: string
  pinned: boolean
  /** An incognito chat: kept out of every list and discarded on leave unless saved. */
  temporary?: boolean
  lastReadAt?: number | null
  createdAt: number
  updatedAt: number
  /** When a pending wait resumes this conversation. */
  waitUntil?: number | null
}

export interface DisplayMessage {
  id: string
  sequence?: number
  toolCallIds?: string[]
  toolCalls?: MessageToolCall[]
  toolCallId?: string
  toolSuccess?: boolean
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  thinking?: string
  imageDataUrls?: string[]
  videoDataUrls?: string[]
  audioDataUrls?: string[]
  structuredContent?: unknown
  contextEvidence?: ContextEvidence[]
  fileAttachments?: { name: string; href?: string }[]
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
  /** The user stopped this reply before the model finished it. */
  stopped?: boolean
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
  /** Project of the active conversation, or the project a new chat will be created in. */
  const activeProjectId = ref<string | null>(null)
  const draftDiscardRevision = ref(0)
  /** The empty new chat will be created as an incognito chat. */
  const incognitoPending = ref(false)
  /** Tool approval for the active chat, or for the empty new chat once it is created. */
  const permissionMode = ref<PermissionMode>('auto')
  /** Bumped when a chat joins the history without changing identity, so lists refetch. */
  const conversationListRevision = ref(0)
  const messages = ref<DisplayMessage[]>([])
  const mediaGenerationSettings = ref<MediaGenerationSettings | null>(null)
  const loadingMessages = ref(false)
  const lastLoadedEventCursor = ref<{ conversationId: string; sequence: number } | null>(null)
  const contextWindow = ref<number | null>(null)
  const modelCost = ref<{ input: number; output: number } | null>(null)
  const modelPricing = ref<ModelPricing | null>(null)
  const modelModalities = ref<{ input: string[]; output: string[] } | null>(null)
  const modelInfoStatus = ref<'idle' | 'loading' | 'ready' | 'unavailable'>('idle')
  let modelInfoRequestId = 0
  const memoryFolders = ref<MemoryFolder[]>([])
  const queuedMessages = ref<QueuedChatMessageDto[]>([])
  const queuePaused = ref(false)
  const pendingWait = ref<PendingWait | null>(null)
  let waitRequestId = 0

  async function loadPendingWait(): Promise<void> {
    const conversationId = activeConversationId.value
    const requestId = ++waitRequestId
    if (!conversationId) return
    try {
      const wait = await api.chat.getPendingWait(conversationId)
      if (requestId === waitRequestId && activeConversationId.value === conversationId) pendingWait.value = wait
    } catch {
      // Keep the last known wait until the next refresh.
    }
  }

  watch(activeConversationId, () => {
    pendingWait.value = null
    void loadPendingWait()
  }, { flush: 'sync' })
  const postActionsMap = new Map<string, Set<string>>()
  const postActionsTrigger = ref(0)
  const quickResponsesMap = new Map<string, { messageId: string | null; suggestions: string[] }>()
  const quickResponsesTrigger = ref(0)
  const activePostActions = computed(() => {
    void postActionsTrigger.value // track changes
    if (!activeConversationId.value) return new Set<string>()
    return postActionsMap.get(activeConversationId.value) || new Set<string>()
  })
  const activeQuickResponses = computed(() => {
    void quickResponsesTrigger.value
    if (!activeConversationId.value) return []
    return quickResponsesMap.get(activeConversationId.value)?.suggestions || []
  })

  // ── Composables ──

  const streaming = useChatStreaming(activeConversationId, messages, conversations, contextWindow)

  // Usage belongs to one conversation. Clear it synchronously whenever the
  // active identity changes so an empty/new chat can never render the previous
  // conversation's context fill while its own state is being established.
  watch(activeConversationId, () => {
    streaming.lastUsage.value = null
    streaming.subAgentUsage.value = null
  }, { flush: 'sync' })

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
  const isConversationLocked = computed(() => activeConversationHasRunningInstance.value || Boolean(pendingWait.value))

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
    // The server never lists incognito chats; keep the open one so its header still resolves.
    const temporary = conversations.value.filter((conversation) => conversation.temporary)
    conversations.value = [...temporary, ...rows.map(
      (r) => ({
        id: r.id,
        title: r.title,
        agentId: r.agent_id,
        projectId: r.project_id ?? null,
        origin: r.origin,
        pinned: !!r.pinned,
        lastReadAt: r.last_read_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at
      })
    )]
  }

  async function handleChannelConversationState(data: {
    conversationId: string
    agentId: string
    running: boolean
  }): Promise<void> {
    agentStore.setConversationExecutionState(data.conversationId, data.running)
    await loadConversations()
    if (activeConversationId.value === data.conversationId) {
      await syncConversationRunState(data.conversationId)
    }
  }

  async function setActiveAgent(id: string | null): Promise<void> {
    if (!memoryFolders.value.length) await loadMemoryFolders()
    await agentConfig.setActiveAgent(id)
    resetStreaming()
  }

  const agentConfig = useChatAgentConfig(activeConversationId, messages, conversations, loadConversations)

  async function loadMemoryFolders(): Promise<void> {
    try {
      const spaces = await api.memoryFolders.list()
      useAgentHealthStore().memoryFolderIds = new Set(spaces.map(space => space.id))
      memoryFolders.value = [...spaces].sort((a, b) => {
        if (a.isUncategorized) return -1
        if (b.isUncategorized) return 1
        return (a.folderPath || '').localeCompare(b.folderPath || '')
      })
    } catch {
      // Non-critical; memory selectors can retry later.
    }
  }

  async function loadQueue(conversationId = activeConversationId.value): Promise<void> {
    if (!conversationId) {
      queuedMessages.value = []
      queuePaused.value = false
      return
    }
    const state = await api.chat.getQueue(conversationId)
    if (activeConversationId.value !== conversationId) return
    queuedMessages.value = state.items
    queuePaused.value = state.paused
  }

  function handleQueueChanged(data: { conversationId: string }): void {
    if (data.conversationId === activeConversationId.value) void loadQueue(data.conversationId)
  }

  async function createConversation(title?: string): Promise<string> {
    const conv = await api.chat.createConversation(
      title,
      agentConfig.activeAgentId.value ?? undefined,
      undefined,
      activeProjectId.value,
      incognitoPending.value,
      permissionMode.value === 'auto' ? undefined : permissionMode.value,
    )
    conversations.value.unshift({
      id: conv.id,
      title: conv.title,
      agentId: conv.agentId,
      projectId: conv.projectId ?? null,
      origin: conv.origin,
      pinned: false,
      temporary: Boolean(conv.temporary),
      lastReadAt: conv.createdAt,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt
    })
    activeConversationId.value = conv.id
    messages.value = []
    queuedMessages.value = []
    queuePaused.value = false
    agentStore.setActiveViewConversation(conv.id)
    return conv.id
  }

  const chatMessages = useChatMessages(
    activeConversationId,
    agentConfig.activeAgentId,
    messages,
    streaming,
    createConversation,
    agentConfig,
    mediaGenerationSettings,
  )

  async function sendMessage(...args: Parameters<typeof chatMessages.sendMessage>): Promise<void> {
    // Cyno chats need Cyno's defaults (system prompt, model) before the first message.
    if (!useCynoStore().profile) await useCynoStore().load().catch(() => undefined)
    if (!memoryFolders.value.length) await loadMemoryFolders()
    agentConfig.ensureCynoPreset()
    const conversationId = activeConversationId.value
    if (conversationId) {
      quickResponsesMap.delete(conversationId)
      quickResponsesTrigger.value++
    }
    await chatMessages.sendMessage(...args)
    const currentConversationId = activeConversationId.value
    if (currentConversationId && (!conversationId || currentConversationId === conversationId)) {
      markConversationRead(currentConversationId)
    }
  }

  // ── Conversation CRUD ──

  async function selectConversation(id: string, agentIdHint?: string | null): Promise<void> {
    const previousConversationId = activeConversationId.value
    if (previousConversationId && previousConversationId !== id) void discardIfTemporary(previousConversationId)
    incognitoPending.value = false
    activeConversationId.value = id
    agentStore.setActiveViewConversation(id)
    markConversationRead(id)
    loadingMessages.value = true
    try {
      const response = await api.chat.getMessages(id)
      if (activeConversationId.value !== id) return
      activeProjectId.value = response.conversationProjectId ?? null
      agentConfig.setConversationAgent(agentIdHint !== undefined ? agentIdHint : response.conversationAgentId)

      // The conversation list is scoped to the selected agent. Entering a chat
      // from the global sidebar can switch that scope, so refresh it before
      // header actions (such as Pin/Unpin) resolve the active conversation.
      await loadConversations()
      if (activeConversationId.value !== id) return
      // An incognito chat opened by URL is missing from the list the server returns.
      if (response.temporary && !conversations.value.some((conversation) => conversation.id === id)) {
        const now = Date.now()
        conversations.value.unshift({
          id,
          title: 'New Chat',
          agentId: response.conversationAgentId,
          projectId: response.conversationProjectId ?? null,
          origin: 'chat',
          pinned: false,
          temporary: true,
          lastReadAt: now,
          createdAt: now,
          updatedAt: now,
        })
      }

      // Apply conversation-specific execution config immediately after setting
      // the agent, before any async work that could trigger a Vue render tick.
      // This prevents a flash where the agent defaults are briefly shown.
      const cfg = response.executionConfig
      agentConfig.restoreConversationConfig(cfg)
      permissionMode.value = response.permissionMode ?? 'auto'

      const lastContextTokens = response.lastContextTokens
      messages.value = response.messages.map((item) => toDisplayMessage(item))
      const lastSubAgentMessage = [...messages.value].reverse().find(
        (message) => message.maInvocationId && message.role === 'assistant' && message.promptTokens != null
      )
      streaming.subAgentUsage.value = lastSubAgentMessage ? {
        promptTokens: lastSubAgentMessage.promptTokens || 0,
        completionTokens: lastSubAgentMessage.completionTokens || 0,
        totalTokens: (lastSubAgentMessage.promptTokens || 0) + (lastSubAgentMessage.completionTokens || 0),
        model: lastSubAgentMessage.model,
      } : null
      lastLoadedEventCursor.value = { conversationId: id, sequence: response.latestEventSequence }

      // Hydrate server-side post-action state
      try {
        const { actions, quickResponses } = await api.chat.getPostActions(id)
        if (activeConversationId.value !== id) return
        if (actions.length) {
          postActionsMap.set(id, new Set(actions))
        } else {
          postActionsMap.delete(id)
        }
        postActionsTrigger.value++
        if (quickResponses?.suggestions.length) {
          quickResponsesMap.set(id, quickResponses)
        } else {
          quickResponsesMap.delete(id)
        }
        quickResponsesTrigger.value++
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
      await loadQueue(id)
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
    modelInfoStatus.value = 'loading'

    const load = (attempt: number): void => {
      api.provider.getModelInfo(providerId, model)
      .then(info => {
        if (requestId !== modelInfoRequestId) return
        const hasMetadata = Boolean(
          info.contextLength ||
          info.cost ||
          info.pricing ||
          info.inputModalities?.length ||
          info.outputModalities?.length ||
          typeof info.supportsToolCalls === 'boolean'
        )
        if (!hasMetadata && attempt < 2) {
          window.setTimeout(() => {
            if (requestId === modelInfoRequestId) load(attempt + 1)
          }, 750 * (attempt + 1))
          return
        }
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
        modelInfoStatus.value = hasMetadata ? 'ready' : 'unavailable'
      })
      .catch(() => {
        if (requestId !== modelInfoRequestId) return
        if (attempt < 2) {
          window.setTimeout(() => {
            if (requestId === modelInfoRequestId) load(attempt + 1)
          }, 750 * (attempt + 1))
          return
        }
        contextWindow.value = null
        modelCost.value = null
        modelPricing.value = null
        modelModalities.value = null
        modelInfoStatus.value = 'unavailable'
      })
    }

    load(0)
  }

  /**
   * Resolved provider + model for the current session.
   * Priority: session override > agent config > provider store defaults.
   */
  const resolvedModelProvider = computed(() => {
    const agent = agentConfig.activeAgentId.value
      ? agentDefs.get(agentConfig.activeAgentId.value)
      : null
    return resolveEffectiveProviderModel({
      providers: providerStore.providers,
      lastUsedProviderId: providerStore.lastUsedProviderId,
      agent,
      providerOverride: agentConfig.sessionProviderOverride.value,
      modelOverride: agentConfig.sessionModelOverride.value,
    })
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
      modelInfoStatus.value = 'idle'
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
    streaming.subAgentUsage.value = null
  }

  /**
   * Start an empty chat. `projectId` places the chat in a project once it is
   * created; omit it to start outside any project.
   */
  async function startNewChat(options: { projectId?: string | null } = {}): Promise<void> {
    activeProjectId.value = options.projectId ?? null
    const previousConversationId = activeConversationId.value
    // Incognito is chosen per chat, so every new chat starts saved.
    incognitoPending.value = false
    draftDiscardRevision.value++
    if (previousConversationId) {
      await api.chat.discardStagedAttachments(previousConversationId)
      await discardIfTemporary(previousConversationId)
    }
    if (!memoryFolders.value.length) await loadMemoryFolders()
    // Every new chat starts from its selected agent or Cyno's defaults.
    agentConfig.syncAgentBaseline()

    if (!activeConversationId.value && messages.value.length === 0) {
      resetStreaming()
      return
    }

    activeConversationId.value = null
    messages.value = []
    agentStore.setActiveViewConversation(null)
    resetStreaming()
  }

  // ── Tool permissions ──

  // Full access is granted per chat; every new chat starts on auto.
  watch(activeConversationId, (id) => {
    if (!id) permissionMode.value = 'auto'
  })

  /** Set what the active chat's runs may do with tools: read-only tools, saved policy (auto), or every tool (full). */
  async function setPermissionMode(mode: PermissionMode): Promise<void> {
    const conversationId = activeConversationId.value
    const previous = permissionMode.value
    permissionMode.value = mode
    if (!conversationId) return
    try {
      await api.chat.setPermissionMode(conversationId, mode)
    } catch (err) {
      if (activeConversationId.value === conversationId) permissionMode.value = previous
      throw err
    }
    if (mode !== 'full') return
    // Full access also answers the tool requests this chat is waiting on.
    // Folder access cards still need their own answer.
    while (
      agentStore.pendingHITL?.conversationId === conversationId
      && !agentStore.pendingHITL.toolCalls.some((toolCall) => toolCall.fileAccess)
    ) {
      await agentStore.respondHITL(true, undefined, 'session', ['*'])
    }
  }

  // ── Incognito chats ──

  /** Whether the open chat, or the empty chat about to be created, is incognito. */
  const activeIsTemporary = computed(() => {
    if (!activeConversationId.value) return incognitoPending.value
    return Boolean(activeConversation.value?.temporary)
  })

  /** Choose incognito for the empty new chat; an existing chat keeps its kind. */
  function setIncognito(on: boolean): void {
    if (activeConversationId.value || messages.value.length) return
    incognitoPending.value = on
  }

  /** Keep the open incognito chat in the history. */
  async function saveActiveConversation(): Promise<void> {
    const conversation = activeConversation.value
    if (!conversation?.temporary) return
    await api.chat.saveConversation(conversation.id)
    conversation.temporary = false
    conversationListRevision.value++
  }

  /**
   * Delete `id` when it is an unsaved incognito chat. Leaving it is the only
   * way out, so an open one also resets the view to an empty new chat.
   */
  async function discardIfTemporary(id: string | null): Promise<void> {
    if (!id || !conversations.value.some((conversation) => conversation.id === id && conversation.temporary)) return
    conversations.value = conversations.value.filter((conversation) => conversation.id !== id)
    streaming.streamBuffers.delete(id)
    postActionsMap.delete(id)
    quickResponsesMap.delete(id)
    if (activeConversationId.value === id) {
      activeConversationId.value = null
      messages.value = []
      queuedMessages.value = []
      queuePaused.value = false
      agentStore.setActiveViewConversation(null)
      resetStreaming()
    }
    try {
      await api.chat.discardConversation(id)
    } catch {
      // The server purges abandoned incognito chats on its next start.
    }
  }

  /**
   * Summarise the active chat now. The summary card arrives through the usual
   * compact events; the context ring is cleared until the next reply measures it.
   */
  async function compactConversation(): Promise<{ compactedMessageCount: number; model: string }> {
    const conversationId = activeConversationId.value
    if (!conversationId) throw new Error('There is nothing to compact yet.')
    const result = await api.chat.compact(conversationId, {
      providerId: resolvedModelProvider.value?.providerId || undefined,
      model: resolvedModelProvider.value?.model || undefined,
    })
    if (activeConversationId.value === conversationId) streaming.lastUsage.value = null
    return result
  }

  /** Move the active chat into a project (or out of one); a new chat applies it on creation. */
  async function setConversationProject(projectId: string | null): Promise<void> {
    const conversationId = activeConversationId.value
    if (conversationId) {
      await api.chat.setProject(conversationId, projectId)
      const conversation = conversations.value.find((candidate) => candidate.id === conversationId)
      if (conversation) conversation.projectId = projectId
    }
    activeProjectId.value = projectId
  }

  /** Restore the agent's default settings and take the chat out of its project. */
  async function resetToDefaults(): Promise<void> {
    agentConfig.resetToDefaults()
    if (activeProjectId.value) await setConversationProject(null)
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
      projectId: fork.projectId ?? null,
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

  function handleQuickResponses(data: { conversationId: string; messageId: string | null; suggestions: string[] }): void {
    if (data.suggestions.length) {
      quickResponsesMap.set(data.conversationId, {
        messageId: data.messageId,
        suggestions: data.suggestions.slice(0, 3),
      })
    } else {
      quickResponsesMap.delete(data.conversationId)
    }
    quickResponsesTrigger.value++
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

  void loadMemoryFolders()

  return {
    // Core state
    conversations,
    sortedConversations,
    activeConversationId,
    activeProjectId,
    draftDiscardRevision,
    incognitoPending,
    permissionMode,
    setPermissionMode,
    conversationListRevision,
    activeIsTemporary,
    messages,
    mediaGenerationSettings,
    loadingMessages,
    lastLoadedEventCursor,
    memoryFolders,
    queuedMessages,
    queuePaused,
    pendingWait,
    loadPendingWait,
    activeConversation,
    activePostActions,
    activeQuickResponses,
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
    subAgentUsage: streaming.subAgentUsage,
    contextWindow,
    modelCost,
    modelPricing,
    modelModalities,
    modelInfoStatus,
    resolvedModelProvider,
    handleStreamStart(data: Parameters<typeof streaming.handleStreamStart>[0]): void {
      if (agentStore.isConversationStopped(data.conversationId, data.streamId)) return
      streaming.handleStreamStart(data)
      agentStore.setConversationExecutionState(data.conversationId, true)
    },
    handleStreamChunk(data: Parameters<typeof streaming.handleStreamChunk>[0]): void {
      if (!agentStore.isConversationStopped(data.conversationId, data.streamId)) streaming.handleStreamChunk(data)
    },
    handleStreamThinking(data: Parameters<typeof streaming.handleStreamThinking>[0]): void {
      if (!agentStore.isConversationStopped(data.conversationId, data.streamId)) streaming.handleStreamThinking(data)
    },
    handleStreamImages(data: Parameters<typeof streaming.handleStreamImages>[0]): void {
      if (!agentStore.isConversationStopped(data.conversationId, data.streamId)) streaming.handleStreamImages(data)
    },
    handleStreamVideos(data: Parameters<typeof streaming.handleStreamVideos>[0]): void {
      if (!agentStore.isConversationStopped(data.conversationId, data.streamId)) streaming.handleStreamVideos(data)
    },
    handleStreamReset(data: Parameters<typeof streaming.handleStreamReset>[0]): void {
      if (!agentStore.isConversationStopped(data.conversationId, data.streamId)) streaming.handleStreamReset(data)
    },
    handleStreamDiscard(data: Parameters<typeof streaming.handleStreamDiscard>[0]): void {
      streaming.handleStreamDiscard(data)
    },
    handleStreamUsage(data: Parameters<typeof streaming.handleStreamUsage>[0]): void {
      if (!agentStore.isConversationStopped(data.conversationId)) streaming.handleStreamUsage(data)
    },
    finalizeCurrentStreaming: streaming.finalizeCurrentStreaming,
    handleStreamEnd(data: { streamId: string; conversationId: string; cancelled?: boolean; usage?: { promptTokens: number; completionTokens: number; totalTokens: number }; model?: string; contextWindow?: number; contextTokens?: number; images?: string[] }): void {
      streaming.handleStreamEnd(data)
    },
    handleStreamError(data: { streamId: string; conversationId: string; error: string }): void {
      streaming.handleStreamError(data)
    },
    handleSubAgentStreamStart(data: Parameters<typeof streaming.handleSubAgentStreamStart>[0]): void {
      if (!agentStore.isConversationStopped(data.conversationId)) streaming.handleSubAgentStreamStart(data)
    },
    handleSubAgentStreamChunk(data: Parameters<typeof streaming.handleSubAgentStreamChunk>[0]): void {
      if (!agentStore.isConversationStopped(data.conversationId)) streaming.handleSubAgentStreamChunk(data)
    },
    handleSubAgentStreamThinking(data: Parameters<typeof streaming.handleSubAgentStreamThinking>[0]): void {
      if (!agentStore.isConversationStopped(data.conversationId)) streaming.handleSubAgentStreamThinking(data)
    },
    handleSubAgentStreamImages(data: Parameters<typeof streaming.handleSubAgentStreamImages>[0]): void {
      if (!agentStore.isConversationStopped(data.conversationId)) streaming.handleSubAgentStreamImages(data)
    },
    handleSubAgentStreamEnd(data: Parameters<typeof streaming.handleSubAgentStreamEnd>[0]): void {
      if (!agentStore.isConversationStopped(data.conversationId)) streaming.handleSubAgentStreamEnd(data)
    },
    handleTitleUpdated: streaming.handleTitleUpdated,
    handleNewMessage: streaming.handleNewMessage,
    handleCompactEvent: streaming.handleCompactEvent,
    handleCompactStart: streaming.handleCompactStart,
    handleCompactError: streaming.handleCompactError,
    handleChannelConversationState,
    handleChatExecutionState(data: ChatExecutionState): void {
      agentStore.handleChatExecutionState(data)
      if (data.state !== 'running') streaming.clearConversationStreamState(data.conversationId)
    },
    handleQueueChanged,

    // Messages (delegated)
    sendMessage,
    async queueMessage(content: string, delivery: ChatQueueDelivery, imageDataUrls?: string[], files?: import('@shared/types').ChatAttachmentInput[], audioDataUrls?: string[], mediaGeneration?: MediaGenerationSettings): Promise<void> {
      if (!memoryFolders.value.length) await loadMemoryFolders()
      agentConfig.ensureCynoPreset()
      await chatMessages.queueMessage(content, delivery, imageDataUrls, files, audioDataUrls, mediaGeneration)
      await loadQueue()
    },
    async updateQueuedMessage(id: string, content: string, imageDataUrls?: string[], files?: import('@shared/types').ChatAttachmentInput[], audioDataUrls?: string[], mediaGeneration?: MediaGenerationSettings): Promise<void> {
      await chatMessages.updateQueuedMessage(id, content, imageDataUrls, files, audioDataUrls, mediaGeneration)
      await loadQueue()
    },
    async removeQueuedMessage(id: string): Promise<void> {
      if (!activeConversationId.value) return
      await api.chat.removeQueued(activeConversationId.value, id)
      await loadQueue()
    },
    async removeQueuedAttachment(id: string, attachmentId: string): Promise<void> {
      if (!activeConversationId.value) return
      await api.chat.removeQueuedAttachment(activeConversationId.value, id, attachmentId)
      await loadQueue()
    },
    async steerQueuedMessage(id: string): Promise<void> {
      if (!activeConversationId.value) return
      await api.chat.steerQueued(activeConversationId.value, id)
      await loadQueue()
    },
    async runNextQueuedMessage(): Promise<void> {
      if (!activeConversationId.value) return
      await api.chat.runNextQueued(activeConversationId.value)
      await loadQueue()
    },
    retryFromMessage: chatMessages.retryFromMessage,
    editMessage: chatMessages.editMessage,
    forkConversationFromMessage,
    async cancelStream(): Promise<void> {
      await chatMessages.cancelStream()
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
    sessionReasoningEffort: agentConfig.sessionReasoningEffort,
    sessionAutoToolRouting: agentConfig.sessionAutoToolRouting,
    sessionAutoMemory: agentConfig.sessionAutoMemory,
    selectedToolNames: agentConfig.selectedToolNames,
    agentOriginalSystemPrompt: agentConfig.agentOriginalSystemPrompt,
    sessionSubAgentIds: agentConfig.sessionSubAgentIds,
    sessionMemoryFolderIds: agentConfig.sessionMemoryFolderIds,
    sessionMemorySelectionInitialized: agentConfig.sessionMemorySelectionInitialized,
    agentOriginalTools: agentConfig.agentOriginalTools,
    agentOriginalSubAgentIds: agentConfig.agentOriginalSubAgentIds,
    agentOriginalMemoryFolderIds: agentConfig.agentOriginalMemoryFolderIds,
    hasAgentOverrides: agentConfig.hasAgentOverrides,
    agentOverrideFields: agentConfig.agentOverrideFields,
    cynoOverrideFields: agentConfig.cynoOverrideFields,
    hasCynoOverrides: agentConfig.hasCynoOverrides,
    markOverridesModified: agentConfig.markOverridesModified,
    setSelectedToolNames: agentConfig.setSelectedToolNames,
    resetAgentOverrides: agentConfig.resetAgentOverrides,
    resetToDefaults,
    applyOverridesToAgent: agentConfig.applyOverridesToAgent,
    setActiveAgent,
    setSessionModel: agentConfig.setSessionModel,
    setSessionReasoningEffort: agentConfig.setSessionReasoningEffort,
    syncAgentBaseline: agentConfig.syncAgentBaseline,
    loadMemoryFolders,
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
    setIncognito,
    saveActiveConversation,
    discardIfTemporary,
    compactConversation,
    setConversationProject,
    handlePostAction,
    handleQuickResponses,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useChatStore, import.meta.hot))
}
