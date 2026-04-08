import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref, computed } from 'vue'
import { api, type StoredMessage } from '../api/client'
import { useAgentStore } from './agent.store'
import { useAgentDefinitionsStore } from './agent-definitions.store'
import { useProviderStore } from './provider.store'

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
  const providerStore = useProviderStore()
  const conversations = ref<Conversation[]>([])
  const activeAgentId = ref<string | null>(
    localStorage.getItem('oa-active-agent') || null
  )
  const activeConversationId = ref<string | null>(null)
  const messages = ref<DisplayMessage[]>([])
  const isStreaming = ref(false)
  const currentStreamId = ref<string | null>(null)
  const streamingContent = ref('')
  const streamingThinking = ref('')
  const lastUsage = ref<{
    promptTokens: number
    completionTokens: number
    totalTokens: number
    model?: string
  } | null>(null)
  const pendingMemorySources = ref<MemorySource[] | null>(null)
  const sessionModelOverride = ref<string | null>(null)
  const sessionProviderOverride = ref<string | null>(null)
  const freeChatSubAgentIds = ref<string[]>([])
  const freeChatMemorySpaceIds = ref<string[]>([])

  // Agent preset override tracking: store the original agent config so we can
  // detect when the user has temporarily overridden tools/sub-agents/memory-spaces.
  const agentOriginalTools = ref<string[]>([])
  const agentOriginalSubAgentIds = ref<string[]>([])
  const agentOriginalMemorySpaceIds = ref<string[]>([])
  const postActionsMap = new Map<string, Set<string>>()
  const postActionsTrigger = ref(0)
  const activePostActions = computed(() => {
    postActionsTrigger.value // track changes
    if (!activeConversationId.value) return new Set<string>()
    return postActionsMap.get(activeConversationId.value) || new Set<string>()
  })

  // Per-conversation stream buffer for background generation
  interface StreamBuffer {
    streamId: string
    content: string
    thinking: string
    active: boolean
    agentId?: string
    agentName?: string
    agentIconUrl?: string | null
  }
  const streamBuffers = new Map<string, StreamBuffer>()

  const activeConversation = computed(() =>
    conversations.value.find((c) => c.id === activeConversationId.value)
  )

  async function loadConversations(): Promise<void> {
    const agentId = activeAgentId.value
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

  async function createConversation(title?: string): Promise<string> {
    const conv = await api.chat.createConversation(
      title,
      activeAgentId.value ?? undefined
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

    // Hydrate server-side post-action state (survives hard reload)
    try {
      const { actions } = await api.chat.getPostActions(id)
      if (actions.length) {
        postActionsMap.set(id, new Set(actions))
      } else {
        postActionsMap.delete(id)
      }
      postActionsTrigger.value++
    } catch {
      // Non-critical — WS events will catch up
    }

    // Restore streaming state if this conversation has an active stream
    const buf = streamBuffers.get(id)
    if (buf?.active) {
      isStreaming.value = true
      currentStreamId.value = buf.streamId
      streamingContent.value = buf.content
      streamingThinking.value = buf.thinking
      messages.value.push({
        id: `streaming_${Date.now()}`,
        role: 'assistant',
        content: buf.content,
        thinking: buf.thinking || undefined,
        agentId: buf.agentId,
        agentName: buf.agentName,
        agentIconUrl: buf.agentIconUrl,
        createdAt: Date.now(),
        isStreaming: true
      })
    } else {
      isStreaming.value = false
      currentStreamId.value = null
      streamingContent.value = ''
      streamingThinking.value = ''
    }
  }

  async function deleteConversation(id: string): Promise<void> {
    await api.chat.deleteConversation(id)
    conversations.value = conversations.value.filter((c) => c.id !== id)
    streamBuffers.delete(id)
    if (activeConversationId.value === id) {
      activeConversationId.value = conversations.value[0]?.id || null
      if (activeConversationId.value) {
        await selectConversation(activeConversationId.value)
      } else {
        messages.value = []
      }
    }
  }

  /** Reset to a blank chat state without creating a DB conversation.
   *  The conversation is created lazily when the first message is sent. */
  function startNewChat(): void {
    // Already in draft state — nothing to do
    if (!activeConversationId.value && messages.value.length === 0) return

    activeConversationId.value = null
    messages.value = []
    streamingContent.value = ''
    streamingThinking.value = ''
    isStreaming.value = false
    currentStreamId.value = null
    lastUsage.value = null
    sessionModelOverride.value = null
    sessionProviderOverride.value = null
  }

  async function deleteAllConversations(): Promise<void> {
    await api.chat.deleteAllConversations(activeAgentId.value)
    conversations.value = []
    activeConversationId.value = null
    messages.value = []
    streamingContent.value = ''
    streamingThinking.value = ''
    isStreaming.value = false
    currentStreamId.value = null
    lastUsage.value = null
  }

  async function sendMessage(
    content: string,
    imageDataUrls?: string[],
    files?: { name: string; content: string }[],
    audioDataUrls?: string[]
  ): Promise<void> {
    if (!activeConversationId.value) {
      await createConversation()
    }

    const conversationId = activeConversationId.value!

    // Generate a stable message ID so the server and client share the same reference,
    // enabling retry/edit to address this exact message by ID.
    const msgId = crypto.randomUUID()

    // Add user message to display immediately
    messages.value.push({
      id: msgId,
      role: 'user',
      content,
      imageDataUrls,
      audioDataUrls,
      createdAt: Date.now()
    })

    // Reset execution control flags for the new turn — keep historical steps
    // visible so previous turns' tool-group cards don't degrade.
    agentStore.clearExecutionState()

    // Add placeholder for streaming response
    streamingContent.value = ''
    streamingThinking.value = ''
    isStreaming.value = true

    const agentDefsLocal = useAgentDefinitionsStore()
    const activeAgent = activeAgentId.value ? agentDefsLocal.get(activeAgentId.value) : null
    messages.value.push({
      id: `streaming_${Date.now()}`,
      role: 'assistant',
      content: '',
      agentName: activeAgent?.name,
      agentIconUrl: activeAgent?.iconUrl ?? undefined,
      createdAt: Date.now(),
      isStreaming: true
    })

    // Determine tools and model based on active agent
    const agentDefs = useAgentDefinitionsStore()
    const agent = activeAgentId.value ? agentDefs.get(activeAgentId.value) : null
    // Always use the local selectedToolNames (synced from agent on activation,
    // but the user can temporarily override them).
    const tools = agentStore.selectedToolNames
    // Only send a model when the user has explicitly overridden it for this session.
    // The server resolves each agent's own model from its config when no override is present.
    // Sending the agent's default model here would propagate it to sub-agents as an override,
    // causing sub-agents to ignore their own configured models.
    // When the provider is overridden without an explicit model, fall back to the
    // overridden provider's default model so the server doesn't try to use the
    // agent's model on a provider that doesn't support it.
    let model = sessionModelOverride.value || undefined
    const providerOverride = sessionProviderOverride.value || undefined
    if (!model && providerOverride) {
      const provider = providerStore.providers.find(p => p.id === providerOverride)
      model = provider?.defaultModel || undefined
    }
    const systemPrompt = agent?.systemPrompt || undefined

    // Read global preference for title generation
    const { usePreferencesStore } = await import('./preferences.store')
    const prefs = usePreferencesStore()

    // Pass sub-agents and memory spaces whenever they are selected
    // (works for both free chat and agent-preset overrides).
    const hasSubAgentOverride = agent && !arraysEqual(freeChatSubAgentIds.value, agentOriginalSubAgentIds.value)
    const hasMemSpaceOverride = agent && !arraysEqual(freeChatMemorySpaceIds.value, agentOriginalMemorySpaceIds.value)
    const subAgents = (hasSubAgentOverride || !agent) && freeChatSubAgentIds.value.length
      ? freeChatSubAgentIds.value.map(id => {
        const def = agentDefs.get(id)
        const codename = def ? def.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : id
        return { agentId: id, codename, role: def?.description || '' }
      })
      : undefined
    const memorySpaceIds = (hasMemSpaceOverride || !agent) && freeChatMemorySpaceIds.value.length
      ? freeChatMemorySpaceIds.value
      : undefined

    // Send to backend (streaming happens via WebSocket events)
    await api.chat.send(
      conversationId,
      content,
      model,
      providerOverride,
      imageDataUrls,
      tools,
      files,
      systemPrompt,
      prefs.generateTitle,
      msgId,
      audioDataUrls,
      subAgents,
      memorySpaceIds
    )
  }

  async function retryFromMessage(messageId: string): Promise<void> {
    if (!activeConversationId.value || isStreaming.value) return
    const idx = messages.value.findIndex(m => m.id === messageId)
    if (idx === -1) return
    const msg = messages.value[idx]
    if (msg.role !== 'user') return
    await api.chat.truncateFrom(activeConversationId.value, messageId)
    messages.value.splice(idx)
    agentStore.clearExecution()
    await sendMessage(msg.content, msg.imageDataUrls)
  }

  async function editMessage(messageId: string, newContent: string): Promise<void> {
    if (!activeConversationId.value || isStreaming.value) return
    const idx = messages.value.findIndex(m => m.id === messageId)
    if (idx === -1) return
    const msg = messages.value[idx]
    if (msg.role !== 'user') return
    await api.chat.truncateFrom(activeConversationId.value, messageId)
    messages.value.splice(idx)
    agentStore.clearExecution()
    await sendMessage(newContent, msg.imageDataUrls)
  }

  function cancelStream(): void {
    // Always cancel using the orchestrator's streamId — sub-agent streams
    // share the same server-side AbortController via the orchestrator.
    // Also always send conversationId as a fallback: after a hard reload
    // primaryStreamId is null, but the server can find the execution by conversation.
    const id = primaryStreamId.value || currentStreamId.value
    const convId = activeConversationId.value
    if (id || convId) {
      api.chat.cancelStream(id || '', convId || undefined)
    }

    // Eagerly clear streaming and execution state for immediate UI feedback
    isStreaming.value = false
    currentStreamId.value = null
    primaryStreamId.value = null
    primaryStreamAgent.value = {}
    const streamMsg = findStreamingMsg()
    if (streamMsg) {
      streamMsg.isStreaming = false
      if (!streamMsg.content && !streamMsg.thinking) {
        messages.value.pop()
      }
    }
    streamingContent.value = ''
    streamingThinking.value = ''
    if (convId) {
      streamBuffers.delete(convId)
    }
    // Keep accumulated steps so already-executed tool cards stay styled after cancel.
    agentStore.clearExecutionState()

    // Also cancel any in-flight post-actions
    if (convId) {
      cancelPostActions()
    }
  }

  function cancelPostActions(): void {
    const convId = activeConversationId.value
    if (!convId) return
    api.chat.cancelPostActions(convId).catch(() => { })
  }

  // Stream event handlers
  // Track the primary stream's identity (the orchestrator) so we can
  // recreate a streaming message when stream-reset arrives after a sub-agent ended it,
  // and so the cancel button always uses the orchestrator's streamId.
  // Only set on the first stream-start per execution (when no buffer exists).
  const primaryStreamId = ref<string | null>(null)
  const primaryStreamAgent = ref<{ agentId?: string; agentName?: string; agentIconUrl?: string | null }>({})

  function handleStreamStart(data: { streamId: string; conversationId: string; agentId?: string; agentName?: string; agentIconUrl?: string | null }): void {
    // Only record as primary agent if no primary stream is currently active
    // (i.e., the orchestrator). Sub-agent stream-starts should NOT overwrite it.
    // Using primaryStreamId instead of streamBuffers because sub-agent per-round
    // stream-end deletes the buffer, causing the next sub-agent stream-start to
    // incorrectly overwrite the orchestrator's identity.
    if (!primaryStreamId.value) {
      primaryStreamId.value = data.streamId
      primaryStreamAgent.value = { agentId: data.agentId, agentName: data.agentName, agentIconUrl: data.agentIconUrl }
    }

    streamBuffers.set(data.conversationId, {
      streamId: data.streamId,
      content: '',
      thinking: '',
      active: true,
      agentId: data.agentId,
      agentName: data.agentName,
      agentIconUrl: data.agentIconUrl
    })

    if (data.conversationId === activeConversationId.value) {
      currentStreamId.value = data.streamId
      isStreaming.value = true

      // Finalize any existing streaming message (e.g. placeholder from sendMessage).
      const lastMsg = messages.value[messages.value.length - 1]
      if (lastMsg?.isStreaming) {
        lastMsg.isStreaming = false
        if (!lastMsg.content && !lastMsg.thinking) {
          messages.value.pop()
        }
      }

      // Always create a fresh streaming placeholder for the new stream
      streamingContent.value = ''
      streamingThinking.value = ''
      messages.value.push({
        id: `streaming_${Date.now()}`,
        role: 'assistant',
        content: '',
        agentId: data.agentId,
        agentName: data.agentName,
        agentIconUrl: data.agentIconUrl,
        createdAt: Date.now(),
        isStreaming: true
      })

      // Attach any pending memory sources to the streaming message
      const streamingMsg = messages.value[messages.value.length - 1]
      if (streamingMsg && streamingMsg.isStreaming && pendingMemorySources.value) {
        streamingMsg.memorySources = pendingMemorySources.value
        pendingMemorySources.value = null
      }
    }
  }

  /** Handle a new message pushed from the server (e.g. cron trigger, tool call results) */
  function handleNewMessage(data: {
    conversationId: string
    message: {
      id: string; conversationId: string; role: string; content: string; createdAt: number
      agentId?: string; agentName?: string; agentIconUrl?: string | null
    }
  }): void {
    if (data.conversationId === activeConversationId.value) {
      // Avoid duplicates
      if (!messages.value.some(m => m.id === data.message.id)) {
        messages.value.push({
          id: data.message.id,
          role: data.message.role as DisplayMessage['role'],
          content: data.message.content,
          agentId: data.message.agentId,
          agentName: data.message.agentName,
          agentIconUrl: data.message.agentIconUrl,
          createdAt: data.message.createdAt
        })
      }
    }
  }

  function findStreamingMsg(): DisplayMessage | undefined {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      if (messages.value[i].isStreaming) return messages.value[i]
    }
    return undefined
  }

  function handleStreamChunk(data: {
    streamId: string
    conversationId: string
    content: string
  }): void {
    const buf = streamBuffers.get(data.conversationId)
    if (buf) buf.content += data.content

    if (data.conversationId === activeConversationId.value) {
      streamingContent.value += data.content
      const streamMsg = findStreamingMsg()
      if (streamMsg) {
        streamMsg.content = streamingContent.value
      }
    }
  }

  function handleStreamThinking(data: {
    streamId: string
    conversationId: string
    thinking: string
  }): void {
    const buf = streamBuffers.get(data.conversationId)
    if (buf) buf.thinking += data.thinking

    if (data.conversationId === activeConversationId.value) {
      streamingThinking.value += data.thinking
      const streamMsg = findStreamingMsg()
      if (streamMsg) {
        streamMsg.thinking = streamingThinking.value
      }
    }
  }

  function handleStreamReset(data: { streamId: string; conversationId: string }): void {
    let buf = streamBuffers.get(data.conversationId)
    if (buf) {
      buf.content = ''
    } else {
      // Sub-agent's stream-end deleted the buffer — recreate it
      buf = {
        streamId: data.streamId, content: '', thinking: '', active: true,
        agentId: primaryStreamAgent.value.agentId,
        agentName: primaryStreamAgent.value.agentName,
        agentIconUrl: primaryStreamAgent.value.agentIconUrl
      }
      streamBuffers.set(data.conversationId, buf)
    }

    if (data.conversationId === activeConversationId.value) {
      streamingContent.value = ''
      // Preserve thinking across rounds so it doesn't vanish when a tool call triggers a new round
      currentStreamId.value = data.streamId
      isStreaming.value = true
      const streamMsg = findStreamingMsg()
      if (streamMsg) {
        streamMsg.content = ''
      } else {
        // No streaming message exists (sub-agent ended it) — recreate one
        // so the orchestrator's next round has somewhere to stream into.
        messages.value.push({
          id: `streaming_${Date.now()}`,
          role: 'assistant',
          content: '',
          agentId: primaryStreamAgent.value.agentId,
          agentName: primaryStreamAgent.value.agentName,
          agentIconUrl: primaryStreamAgent.value.agentIconUrl,
          createdAt: Date.now(),
          isStreaming: true
        })
      }
    }
  }

  function handleStreamImages(data: {
    streamId: string
    conversationId: string
    images: string[]
  }): void {
    if (data.conversationId === activeConversationId.value) {
      const streamMsg = findStreamingMsg()
      if (streamMsg) {
        streamMsg.imageDataUrls = [...(streamMsg.imageDataUrls || []), ...data.images]
      }
    }
  }

  function handleStreamEnd(data: {
    streamId: string
    conversationId: string
    cancelled?: boolean
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
    model?: string
  }): void {
    streamBuffers.delete(data.conversationId)

    const isPrimaryStream = data.streamId === primaryStreamId.value

    // Only clear primary tracking when the orchestrator's stream ends
    if (isPrimaryStream) {
      primaryStreamId.value = null
      primaryStreamAgent.value = {}
    }

    if (data.conversationId === activeConversationId.value) {
      // Sub-agent per-round stream-ends should NOT finalize the overall
      // streaming state — the orchestrator is still running.
      if (isPrimaryStream) {
        isStreaming.value = false
        currentStreamId.value = null
      }

      const streamMsg = findStreamingMsg()
      if (streamMsg) {
        if (isPrimaryStream) {
          // Primary orchestrator stream ended — fully finalize
          streamMsg.isStreaming = false
          streamMsg.createdAt = Date.now()
          streamMsg.model = data.model
          if (data.usage) {
            streamMsg.promptTokens = data.usage.promptTokens
            streamMsg.completionTokens = data.usage.completionTokens
          }
          if (!data.cancelled && !streamMsg.content && !streamMsg.thinking) {
            streamMsg.isError = true
            streamMsg.content = 'No response received from the model.'
          }
        } else {
          // Sub-agent per-round stream ended — finalize the placeholder
          // but don't flag as error when empty (tool-call-only rounds are normal).
          streamMsg.isStreaming = false
          streamMsg.createdAt = Date.now()
          if (!streamMsg.content && !streamMsg.thinking) {
            // Empty sub-agent round (tool calls only) — remove the placeholder
            // so it doesn't clutter the chat with blank messages.
            const idx = messages.value.indexOf(streamMsg)
            if (idx !== -1) messages.value.splice(idx, 1)
          }
        }
      }

      if (isPrimaryStream) {
        if (data.usage) {
          lastUsage.value = { ...data.usage, model: data.model }
        }
        streamingContent.value = ''
        streamingThinking.value = ''
      }
    }
  }

  function handleStreamError(data: {
    streamId: string
    conversationId: string
    error: string
  }): void {
    streamBuffers.delete(data.conversationId)

    if (data.streamId === primaryStreamId.value) {
      primaryStreamId.value = null
      primaryStreamAgent.value = {}
    }

    if (data.conversationId === activeConversationId.value) {
      isStreaming.value = false
      currentStreamId.value = null

      const streamMsg = findStreamingMsg()
      if (streamMsg) {
        streamMsg.isStreaming = false
        streamMsg.isError = true
        streamMsg.content = data.error
      } else {
        // No streaming message found — create a new error message
        messages.value.push({
          id: `error_${Date.now()}`,
          role: 'assistant',
          content: data.error,
          isError: true,
          createdAt: Date.now()
        })
      }
    }
  }

  function handleTitleUpdated(data: { conversationId: string; title: string }): void {
    const conv = conversations.value.find((c) => c.id === data.conversationId)
    if (conv) {
      conv.title = data.title
    }
  }

  function handleMemorySources(data: {
    conversationId: string
    sources: MemorySource[]
  }): void {
    if (data.conversationId === activeConversationId.value) {
      // Attach to the last streaming assistant message or store for next one
      const lastMsg = messages.value[messages.value.length - 1]
      if (lastMsg && lastMsg.role === 'assistant') {
        lastMsg.memorySources = data.sources
      } else {
        // Store temporarily — will attach when streaming message is created
        pendingMemorySources.value = data.sources
      }
    }
  }

  function arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false
    const sorted1 = [...a].sort()
    const sorted2 = [...b].sort()
    return sorted1.every((v, i) => v === sorted2[i])
  }

  // Track whether the user has actively modified overrides in this session.
  // Prevents the override notice from showing on cold start before any user action.
  const userModifiedOverrides = ref(false)

  const hasAgentOverrides = computed(() => {
    if (!activeAgentId.value || !userModifiedOverrides.value) return false
    return (
      !arraysEqual(agentStore.selectedToolNames, agentOriginalTools.value) ||
      !arraysEqual(freeChatSubAgentIds.value, agentOriginalSubAgentIds.value) ||
      !arraysEqual(freeChatMemorySpaceIds.value, agentOriginalMemorySpaceIds.value)
    )
  })

  function resetAgentOverrides(): void {
    agentStore.selectedToolNames = [...agentOriginalTools.value]
    freeChatSubAgentIds.value = [...agentOriginalSubAgentIds.value]
    freeChatMemorySpaceIds.value = [...agentOriginalMemorySpaceIds.value]
    userModifiedOverrides.value = false
  }

  async function applyOverridesToAgent(): Promise<void> {
    if (!activeAgentId.value) return
    const agentDefs = useAgentDefinitionsStore()
    const updates: Record<string, unknown> = {}

    if (!arraysEqual(agentStore.selectedToolNames, agentOriginalTools.value)) {
      updates.tools = [...agentStore.selectedToolNames]
    }
    if (!arraysEqual(freeChatSubAgentIds.value, agentOriginalSubAgentIds.value)) {
      updates.subAgents = freeChatSubAgentIds.value.map(id => {
        const def = agentDefs.get(id)
        const codename = def
          ? def.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
          : id
        return { agentId: id, codename, role: def?.description || '' }
      })
    }
    if (!arraysEqual(freeChatMemorySpaceIds.value, agentOriginalMemorySpaceIds.value)) {
      updates.memorySpaces = [...freeChatMemorySpaceIds.value]
    }

    if (Object.keys(updates).length === 0) return
    await agentDefs.update(activeAgentId.value, updates)

    // Snapshot the new originals
    agentOriginalTools.value = [...agentStore.selectedToolNames]
    agentOriginalSubAgentIds.value = [...freeChatSubAgentIds.value]
    agentOriginalMemorySpaceIds.value = [...freeChatMemorySpaceIds.value]
    userModifiedOverrides.value = false
  }

  async function setActiveAgent(id: string | null) {
    activeAgentId.value = id
    userModifiedOverrides.value = false
    if (id) {
      localStorage.setItem('oa-active-agent', id)
      const agentDefs = useAgentDefinitionsStore()
      const agent = agentDefs.get(id)
      // Sync tool selection UI with the agent's preset
      const tools = agent?.tools?.length ? [...agent.tools] : []
      agentStore.selectedToolNames = tools
      agentOriginalTools.value = [...tools]
      // Sync sub-agent and memory-space selections
      const subAgentIds = agent?.subAgents?.map(s => s.agentId) ?? []
      freeChatSubAgentIds.value = [...subAgentIds]
      agentOriginalSubAgentIds.value = [...subAgentIds]
      const memSpaceIds = agent?.memorySpaces?.length ? [...agent.memorySpaces] : []
      freeChatMemorySpaceIds.value = [...memSpaceIds]
      agentOriginalMemorySpaceIds.value = [...memSpaceIds]
    } else {
      localStorage.removeItem('oa-active-agent')
      agentStore.clearSelectedTools()
      freeChatSubAgentIds.value = []
      freeChatMemorySpaceIds.value = []
      agentOriginalTools.value = []
      agentOriginalSubAgentIds.value = []
      agentOriginalMemorySpaceIds.value = []
    }
    // Reset per-session model override when switching agents
    sessionModelOverride.value = null
    sessionProviderOverride.value = null
    // Reload conversations scoped to the new agent
    activeConversationId.value = null
    messages.value = []
    await loadConversations()
  }

  function setSessionModel(model: string | null, providerId?: string | null): void {
    sessionModelOverride.value = model || null
    sessionProviderOverride.value = (model ? providerId : null) || null
  }

  /** Sync override originals from the active agent after agent definitions are loaded.
   *  Called once on startup so that a page refresh keeps the correct baseline. */
  function syncAgentBaseline(): void {
    if (!activeAgentId.value) return
    const agentDefs = useAgentDefinitionsStore()
    const agent = agentDefs.get(activeAgentId.value)
    if (!agent) return
    const tools = agent.tools?.length ? [...agent.tools] : []
    agentStore.selectedToolNames = tools
    agentOriginalTools.value = [...tools]
    const subIds = agent.subAgents?.map(s => s.agentId) ?? []
    freeChatSubAgentIds.value = [...subIds]
    agentOriginalSubAgentIds.value = [...subIds]
    const memIds = agent.memorySpaces?.length ? [...agent.memorySpaces] : []
    freeChatMemorySpaceIds.value = [...memIds]
    agentOriginalMemorySpaceIds.value = [...memIds]
    userModifiedOverrides.value = false
  }

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

  return {
    conversations,
    activeConversationId,
    activeAgentId,
    messages,
    isStreaming,
    currentStreamId,
    streamingContent,
    streamingThinking,
    lastUsage,
    activeConversation,
    sessionModelOverride,
    sessionProviderOverride,
    freeChatSubAgentIds,
    freeChatMemorySpaceIds,
    hasAgentOverrides,
    agentOriginalTools,
    agentOriginalSubAgentIds,
    agentOriginalMemorySpaceIds,
    markOverridesModified() { userModifiedOverrides.value = true },
    resetAgentOverrides,
    applyOverridesToAgent,
    loadConversations,
    createConversation,
    startNewChat,
    selectConversation,
    deleteConversation,
    deleteAllConversations,
    sendMessage,
    retryFromMessage,
    editMessage,
    cancelStream,
    handleStreamStart,
    handleStreamChunk,
    handleStreamThinking,
    handleStreamImages,
    handleStreamReset,
    handleStreamEnd,
    handleStreamError,
    handleTitleUpdated,
    handleMemorySources,
    handleNewMessage,
    handlePostAction,
    activePostActions,
    cancelPostActions,
    setActiveAgent,
    setSessionModel,
    syncAgentBaseline
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useChatStore, import.meta.hot))
}
