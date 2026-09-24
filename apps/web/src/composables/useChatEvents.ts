import { watch } from 'vue'
import type { ChatEvent, MessageItem } from '@shared/types'
import { api } from '../api/client'
import { wsConnected } from '../api/http'
import { useChatStore } from '../stores/chat.store'
import { useAgentStore } from '../stores/agent-runtime.store'
import { toDisplayMessage } from '../utils/message-view'

/** Reduce live and replayed canonical events through the same chat state path. */
export function useChatEvents(): () => void {
  const chatStore = useChatStore()
  const agentStore = useAgentStore()

  const eventCursors = new Map<string, number>()
  const replayingEvents = new Map<string, ChatEvent[]>()
  const loadingEvents = new Map<string, ChatEvent[]>()

  function applyOrBufferChatEvent(event: ChatEvent): void {
    if (chatStore.loadingMessages && chatStore.activeConversationId === event.conversationId) {
      const pending = loadingEvents.get(event.conversationId) || []
      pending.push(event)
      loadingEvents.set(event.conversationId, pending)
    } else handleChatEvent(event)
  }

  function flushLoadedChatEvents(conversationId: string): void {
    if (chatStore.loadingMessages && chatStore.activeConversationId === conversationId) return
    const pending = loadingEvents.get(conversationId) || []
    loadingEvents.delete(conversationId)
    pending.sort((a, b) => a.sequence - b.sequence).forEach(handleChatEvent)
  }

  function receiveChatEvent(event: ChatEvent): void {
    const pending = replayingEvents.get(event.conversationId)
    if (pending) pending.push(event)
    else applyOrBufferChatEvent(event)
  }

  async function resumeChatEvents(): Promise<void> {
    await Promise.all([...eventCursors].map(async ([conversationId, cursor]) => {
      if (replayingEvents.has(conversationId)) return
      const pending: ChatEvent[] = []
      replayingEvents.set(conversationId, pending)
      try {
        let after = cursor
        for (;;) {
          const page = await api.chat.getEvents(conversationId, after)
          for (const event of page.events) applyOrBufferChatEvent(event)
          if (!page.events.length || page.events.length < 1000 || after >= page.latestSequence) break
          after = page.events[page.events.length - 1].sequence
        }
      } catch {
        // The active conversation load still restores persisted messages.
      } finally {
        replayingEvents.delete(conversationId)
        pending.sort((a, b) => a.sequence - b.sequence).forEach(applyOrBufferChatEvent)
      }
    }))
  }

  function handleChatEvent(event: ChatEvent): void {
    if (event.version !== 1) return
    const previous = eventCursors.get(event.conversationId) || 0
    if (event.sequence <= previous) return
    eventCursors.set(event.conversationId, event.sequence)
    const base = { streamId: 'streamId' in event ? event.streamId : event.executionId, conversationId: event.conversationId }
    switch (event.type) {
      case 'stream-start': {
        const data = { ...base, sequence: event.sequence, createdAt: event.createdAt,
          agentId: event.agentId, agentName: event.agentName, agentIconUrl: event.agentIconUrl,
          maInvocationId: event.invocationId, maCodename: event.maCodename, maAgentName: event.maAgentName }
        if (event.scope === 'subagent') chatStore.handleSubAgentStreamStart(data)
        else chatStore.handleStreamStart(data)
        return
      }
      case 'content-delta': {
        if (event.block.type === 'reasoning') {
          if (event.scope === 'subagent') chatStore.handleSubAgentStreamThinking({ ...base, thinking: event.block.text })
          else chatStore.handleStreamThinking({ ...base, thinking: event.block.text })
        } else if (event.scope === 'subagent') chatStore.handleSubAgentStreamChunk({ ...base, content: event.block.text })
        else chatStore.handleStreamChunk({ ...base, content: event.block.text })
        return
      }
      case 'media-added': {
        const images = event.blocks.flatMap((block) => block.type === 'image' ? [block.url] : [])
        const videos = event.blocks.flatMap((block) => block.type === 'video' ? [block.url] : [])
        if (images.length) {
          if (event.scope === 'subagent') chatStore.handleSubAgentStreamImages({ ...base, images })
          else chatStore.handleStreamImages({ ...base, images })
        }
        if (videos.length && event.scope === 'main') chatStore.handleStreamVideos({ ...base, videos })
        return
      }
      case 'stream-reset':
        if (event.scope === 'main') chatStore.handleStreamReset(base)
        return
      case 'stream-discard':
        if (event.scope === 'main') chatStore.handleStreamDiscard(base)
        return
      case 'stream-end':
        if (event.scope === 'subagent') chatStore.handleSubAgentStreamEnd({ ...base, cancelled: event.cancelled, model: event.model, usage: event.usage })
        else chatStore.handleStreamEnd({ ...base, cancelled: event.cancelled, model: event.model, usage: event.usage, contextTokens: event.contextTokens, contextWindow: event.contextWindow, images: event.images })
        return
      case 'stream-error':
        chatStore.handleStreamError({ ...base, error: event.error })
        return
      case 'usage':
        chatStore.handleStreamUsage({ conversationId: event.conversationId, scope: event.scope, usage: event, contextTokens: event.contextTokens, contextWindow: event.contextWindow, model: event.model })
        return
      case 'execution-state':
        chatStore.handleChatExecutionState({ executionId: event.executionId, conversationId: event.conversationId, agentId: event.agentId, state: event.state })
        return
      case 'queue-changed':
        chatStore.handleQueueChanged({ conversationId: event.conversationId })
        return
      case 'title-updated':
        chatStore.handleTitleUpdated({ conversationId: event.conversationId, title: event.title })
        return
      case 'post-action':
        chatStore.handlePostAction({ conversationId: event.conversationId, action: event.action, status: event.status })
        return
      case 'quick-responses':
        chatStore.handleQuickResponses({ conversationId: event.conversationId, messageId: event.messageId, suggestions: event.suggestions })
        return
      case 'compact-start':
        chatStore.handleCompactStart({ conversationId: event.conversationId })
        return
      case 'compact-error':
        chatStore.handleCompactError({ conversationId: event.conversationId, error: event.error })
        return
      case 'compact-event':
        chatStore.handleCompactEvent({ conversationId: event.conversationId, messageId: event.messageId, summary: event.summary,
          compactedMessageCount: event.compactedMessageCount, model: event.model, createdAt: event.createdAt })
        return
      case 'transcript-item': {
        if (event.item.type === 'execution-marker') {
          const marker = event.item
          const name = marker.status === 'started' ? 'task:started'
            : marker.status === 'completed' ? 'task:completed' : 'task:error'
          agentStore.handleExecutionUpdate({ event: name, data: {
            conversationId: event.conversationId, executionId: event.executionId,
            taskId: marker.taskId, maCodename: marker.maCodename, error: marker.detail,
          } })
          return
        }
        if (event.item.type !== 'message') return
        const item: MessageItem = event.item
        chatStore.handleNewMessage({ conversationId: event.conversationId, streamId: event.executionId, message: {
          ...toDisplayMessage(item, event.sequence), conversationId: event.conversationId,
        } })
        return
      }
      case 'execution-step':
      case 'routing-decision':
      case 'tool-calls':
      case 'tool-results':
        agentStore.handleChatToolEvent(event)
        return
    }
  }

  const stopCursorWatch = watch(() => chatStore.lastLoadedEventCursor, (cursor) => {
    if (!cursor) return
    eventCursors.set(cursor.conversationId, Math.max(eventCursors.get(cursor.conversationId) || 0, cursor.sequence))
    flushLoadedChatEvents(cursor.conversationId)
    void resumeChatEvents()
  }, { flush: 'sync' })

  const stopLoadingWatch = watch(() => chatStore.loadingMessages, (loading) => {
    if (!loading && chatStore.activeConversationId) flushLoadedChatEvents(chatStore.activeConversationId)
  }, { flush: 'sync' })

  const stopConversationWatch = watch(() => chatStore.activeConversationId, (activeId) => {
    for (const conversationId of loadingEvents.keys()) {
      if (conversationId !== activeId) flushLoadedChatEvents(conversationId)
    }
  }, { flush: 'sync' })

  const stopConnectionWatch = watch(wsConnected, (connected) => {
    if (connected) void resumeChatEvents()
  })
  const unsubscribe = api.chat.onEvent(receiveChatEvent)
  return () => {
    unsubscribe()
    stopConnectionWatch()
    stopCursorWatch()
    stopLoadingWatch()
    stopConversationWatch()
  }
}
