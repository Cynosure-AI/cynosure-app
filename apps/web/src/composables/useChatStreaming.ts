import { reactive, ref, type Ref } from 'vue'
import { api } from '../api/client'
import type { DisplayMessage } from '../stores/chat.store'

export interface TokenUsage {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    model?: string
    /** Cumulative context token count from the server (updated every LLM round) */
    contextTokens?: number
}

interface StreamBuffer {
    streamId: string
    conversationId: string
    content: string
    thinking: string
    images: string[]
    videos: string[]
    active: boolean
    agentId?: string
    agentName?: string
    agentIconUrl?: string | null
    maCodename?: string
    maAgentName?: string
    maInvocationId?: string
    createdAt: number
    sequence?: number
}

export interface ChatStreamingState {
    isStreaming: Ref<boolean>
    currentStreamId: Ref<string | null>
    streamingContent: Ref<string>
    streamingThinking: Ref<string>
    lastUsage: Ref<TokenUsage | null>

    primaryStreamId: Ref<string | null>
    primaryStreamAgent: Ref<{ agentId?: string; agentName?: string; agentIconUrl?: string | null }>
    streamBuffers: Map<string, StreamBuffer>
    subAgentStreamBuffers: Map<string, StreamBuffer>
    clearConversationStreamState(conversationId: string): void
    findStreamingMsg(streamId?: string): DisplayMessage | undefined
    restorePrimaryStream(conversationId: string): void
    restoreSubAgentStreams(conversationId: string): void
    finalizeCurrentStreaming(conversationId: string): void
    handleStreamStart(data: { streamId: string; conversationId: string; sequence?: number; createdAt?: number; agentId?: string; agentName?: string; agentIconUrl?: string | null; maCodename?: string; maAgentName?: string; maInvocationId?: string }): void
    handleStreamChunk(data: { streamId: string; conversationId: string; content: string }): void
    handleStreamThinking(data: { streamId: string; conversationId: string; thinking: string }): void
    handleStreamImages(data: { streamId: string; conversationId: string; images: string[] }): void
    handleStreamVideos(data: { streamId: string; conversationId: string; videos: string[] }): void
    handleStreamReset(data: { streamId: string; conversationId: string }): void
    handleStreamDiscard(data: { streamId: string; conversationId: string }): void
    handleStreamUsage(data: { conversationId: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number }; model?: string; contextWindow?: number; contextTokens?: number }): void
    handleStreamEnd(data: { streamId: string; conversationId: string; cancelled?: boolean; usage?: { promptTokens: number; completionTokens: number; totalTokens: number }; model?: string; contextWindow?: number; contextTokens?: number; images?: string[] }): void
    handleStreamError(data: { streamId: string; conversationId: string; error: string }): void
    handleSubAgentStreamStart(data: { streamId: string; conversationId: string; sequence?: number; createdAt?: number; agentId?: string; agentName?: string; agentIconUrl?: string | null; maCodename?: string; maAgentName?: string; maInvocationId?: string }): void
    handleSubAgentStreamChunk(data: { streamId: string; conversationId: string; content: string }): void
    handleSubAgentStreamThinking(data: { streamId: string; conversationId: string; thinking: string }): void
    handleSubAgentStreamImages(data: { streamId: string; conversationId: string; images: string[] }): void
    handleSubAgentStreamEnd(data: { streamId: string; conversationId: string; cancelled?: boolean; model?: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }): void
    handleTitleUpdated(data: { conversationId: string; title: string }): void
    handleNewMessage(data: { conversationId: string; streamId?: string; message: { id: string; conversationId: string; sequence?: number; toolCallIds?: string[]; role: string; isError?: boolean; content: string; thinking?: string; createdAt: number; imageDataUrls?: string[]; videoDataUrls?: string[]; audioDataUrls?: string[]; structuredContent?: unknown; fileAttachments?: { name: string; href?: string }[]; agentId?: string; agentName?: string; agentIconUrl?: string | null; maCodename?: string; maAgentName?: string; maInvocationId?: string } }): void
    handleCompactEvent(data: { conversationId: string; messageId: string; summary: string; compactedMessageCount: number; model: string; createdAt: number }): void
    handleCompactStart(data: { conversationId: string }): void
    handleCompactError(data: { conversationId: string; error: string }): void
}

export function useChatStreaming(
    activeConversationId: Ref<string | null>,
    messages: Ref<DisplayMessage[]>,
    conversations: Ref<{ id: string; title: string; updatedAt?: number; lastReadAt?: number | null }[]>,
    contextWindow: Ref<number | null>,
): ChatStreamingState {
    const isStreaming = ref(false)
    const currentStreamId = ref<string | null>(null)
    const streamingContent = ref('')
    const streamingThinking = ref('')
    const lastUsage = ref<TokenUsage | null>(null)
    const primaryStreamId = ref<string | null>(null)
    const primaryStreamAgent = ref<{ agentId?: string; agentName?: string; agentIconUrl?: string | null }>({})
    // These maps are consumed by computed state outside this composable. Keep
    // them reactive so adding/removing a stream invalidates those computations.
    const streamBuffers = reactive(new Map<string, StreamBuffer>())
    const subAgentStreamBuffers = reactive(new Map<string, StreamBuffer>())
    const subAgentStreamMsgs = new Map<string, DisplayMessage>()
    /** Tracks the last completed (non-empty) sub-agent message so the final
     *  subagent-stream-end event (which carries model/usage) can find it
     *  even after subAgentStreamMsgs has been cleared for a stream. */
    const lastCompletedSubAgentMsgs = new Map<string, DisplayMessage>()
    /** All primary-stream messages created in the current turn (reset on stream-start).
     *  Used to back-fill the model on earlier round messages when stream-end arrives. */
    const currentTurnMsgs: DisplayMessage[] = []

    function scopedStreamKey(conversationId: string, streamId: string): string {
        return `${conversationId}::${streamId}`
    }

    function findStreamingMsg(streamId?: string): DisplayMessage | undefined {
        for (let i = messages.value.length - 1; i >= 0; i--) {
            if (!messages.value[i].isStreaming) continue
            if (!streamId || messages.value[i].streamId === streamId) return messages.value[i]
        }
        return undefined
    }

    function findMsgByStreamId(streamId: string): DisplayMessage | undefined {
        for (let i = messages.value.length - 1; i >= 0; i--) {
            if (messages.value[i].streamId === streamId) return messages.value[i]
        }
        return undefined
    }

    function hasVisibleContent(msg: DisplayMessage): boolean {
        return Boolean(msg.content || msg.thinking || msg.imageDataUrls?.length || msg.videoDataUrls?.length)
    }

    function pushStreamErrorMessage(error: string): void {
        messages.value.push({
            id: `error_${Date.now()}`,
            role: 'assistant',
            content: error,
            isError: true,
            createdAt: Date.now()
        })
    }

    function findReusableStreamingPlaceholder(): DisplayMessage | undefined {
        for (let i = messages.value.length - 1; i >= 0; i--) {
            const msg = messages.value[i]
            if (msg.role === 'user') return undefined
            if (msg.role !== 'assistant' || !msg.isStreaming || msg.streamId || hasVisibleContent(msg)) continue
            return msg
        }
        return undefined
    }

    function findPersistedMatchForBuffer(buf: StreamBuffer): DisplayMessage | undefined {
        return messages.value.find((message) => message.role === 'assistant' && message.streamId === buf.streamId)
    }

    function hydrateMessageFromBuffer(msg: DisplayMessage, buf: StreamBuffer): void {
        msg.streamId = buf.streamId
        msg.content = buf.content
        msg.thinking = buf.thinking || undefined
        msg.agentId = buf.agentId
        msg.agentName = buf.agentName
        msg.agentIconUrl = buf.agentIconUrl
        msg.maCodename = buf.maCodename
        msg.maAgentName = buf.maAgentName
        msg.maInvocationId = buf.maInvocationId
        msg.isStreaming = true
        if (buf.images.length) appendUniqueImages(msg, buf.images)
        if (buf.videos.length) appendUniqueVideos(msg, buf.videos)
    }

    function appendUniqueImages(msg: DisplayMessage, images: string[]): void {
        if (!images.length) return
        const existing = new Set(msg.imageDataUrls || [])
        const next = images.filter((url) => {
            if (existing.has(url)) return false
            existing.add(url)
            return true
        })
        if (next.length) {
            msg.imageDataUrls = [...(msg.imageDataUrls || []), ...next]
        }
    }

    function appendUniqueVideos(msg: DisplayMessage, videos: string[]): void {
        if (!videos.length) return
        const existing = new Set(msg.videoDataUrls || [])
        const next = videos.filter((url) => {
            if (existing.has(url)) return false
            existing.add(url)
            return true
        })
        if (next.length) {
            msg.videoDataUrls = [...(msg.videoDataUrls || []), ...next]
        }
    }

    function clearConversationStreamState(conversationId: string): void {
        const buf = streamBuffers.get(conversationId)
        const streamIds = new Set<string>()
        if (buf?.streamId) streamIds.add(buf.streamId)
        for (const [key, subBuf] of subAgentStreamBuffers.entries()) {
            if (subBuf.conversationId !== conversationId) continue
            streamIds.add(subBuf.streamId)
            subAgentStreamBuffers.delete(key)
            subAgentStreamMsgs.delete(key)
            lastCompletedSubAgentMsgs.delete(key)
        }
        streamBuffers.delete(conversationId)

        if (buf?.streamId && buf.streamId === primaryStreamId.value) {
            primaryStreamId.value = null
            primaryStreamAgent.value = {}
        }

        if (conversationId === activeConversationId.value) {
            isStreaming.value = false
            currentStreamId.value = null
            primaryStreamId.value = null
            primaryStreamAgent.value = {}
            streamingContent.value = ''
            streamingThinking.value = ''
            for (let i = messages.value.length - 1; i >= 0; i--) {
                const message = messages.value[i]
                if (!message.isStreaming) continue
                if (streamIds.size && message.streamId && !streamIds.has(message.streamId)) continue
                message.isStreaming = false
                if (!message.content && !message.thinking && !message.imageDataUrls?.length && !message.videoDataUrls?.length) {
                    messages.value.splice(i, 1)
                }
            }
        }
    }

    function restoreSubAgentStreams(conversationId: string): void {
        for (const [key, buf] of subAgentStreamBuffers.entries()) {
            if (!buf.active || buf.conversationId !== conversationId) continue
            const existingMsg = subAgentStreamMsgs.get(key)
            if (existingMsg && messages.value.includes(existingMsg)) continue
            if (existingMsg) subAgentStreamMsgs.delete(key)

            const persistedMatch = findPersistedMatchForBuffer(buf)
            if (persistedMatch) {
                hydrateMessageFromBuffer(persistedMatch, buf)
                subAgentStreamMsgs.set(key, persistedMatch)
                continue
            }

            const msg: DisplayMessage = {
                id: `sa_stream_${buf.streamId}`,
                sequence: buf.sequence,
                role: 'assistant',
                content: buf.content,
                streamId: buf.streamId,
                thinking: buf.thinking || undefined,
                imageDataUrls: buf.images.length ? [...buf.images] : undefined,
                videoDataUrls: buf.videos.length ? [...buf.videos] : undefined,
                agentId: buf.agentId,
                agentName: buf.agentName,
                agentIconUrl: buf.agentIconUrl,
                maCodename: buf.maCodename,
                maAgentName: buf.maAgentName,
                maInvocationId: buf.maInvocationId,
                createdAt: buf.createdAt,
                isStreaming: true
            }
            messages.value.push(msg)
            subAgentStreamMsgs.set(key, msg)
        }
    }

    function restorePrimaryStream(conversationId: string): void {
        const buf = streamBuffers.get(conversationId)
        if (!buf?.active) {
            isStreaming.value = false
            currentStreamId.value = null
            primaryStreamId.value = null
            streamingContent.value = ''
            streamingThinking.value = ''
            return
        }

        isStreaming.value = true
        currentStreamId.value = buf.streamId
        primaryStreamId.value = buf.streamId
        streamingContent.value = buf.content
        streamingThinking.value = buf.thinking

        if (conversationId !== activeConversationId.value) return

        const existingStreamMsg = findStreamingMsg(buf.streamId)
        if (existingStreamMsg) {
            hydrateMessageFromBuffer(existingStreamMsg, buf)
            return
        }

        const persistedMatch = findPersistedMatchForBuffer(buf)
        if (persistedMatch) {
            hydrateMessageFromBuffer(persistedMatch, buf)
            return
        }

        const msg: DisplayMessage = {
            id: `streaming_${buf.streamId}`,
            sequence: buf.sequence,
            role: 'assistant',
            content: buf.content,
            streamId: buf.streamId,
            thinking: buf.thinking || undefined,
            imageDataUrls: buf.images.length ? [...buf.images] : undefined,
            videoDataUrls: buf.videos.length ? [...buf.videos] : undefined,
            agentId: buf.agentId,
            agentName: buf.agentName,
            agentIconUrl: buf.agentIconUrl,
            maCodename: buf.maCodename,
            maAgentName: buf.maAgentName,
            maInvocationId: buf.maInvocationId,
            createdAt: buf.createdAt,
            isStreaming: true
        }
        messages.value.push(msg)
    }

    function finalizeCurrentStreaming(conversationId: string): void {
        if (conversationId !== activeConversationId.value) return
        const streamMsg = findStreamingMsg()
        if (streamMsg && (streamMsg.content || streamMsg.thinking || streamMsg.imageDataUrls?.length || streamMsg.videoDataUrls?.length)) {
            streamMsg.isStreaming = false
        }
    }

    function handleStreamStart(data: { streamId: string; conversationId: string; sequence?: number; createdAt?: number; agentId?: string; agentName?: string; agentIconUrl?: string | null; maCodename?: string; maAgentName?: string; maInvocationId?: string }): void {
        // These refs describe the stream in the visible chat only. Background
        // runs are retained in streamBuffers, but must never replace the active
        // conversation's identity (a cron run used to leak its agent here).
        if (data.conversationId === activeConversationId.value) {
            primaryStreamId.value = data.streamId
            primaryStreamAgent.value = { agentId: data.agentId, agentName: data.agentName, agentIconUrl: data.agentIconUrl }
        }

        streamBuffers.set(data.conversationId, {
            streamId: data.streamId,
            conversationId: data.conversationId,
            content: '',
            thinking: '',
            images: [],
            videos: [],
            active: true,
            agentId: data.agentId,
            agentName: data.agentName,
            agentIconUrl: data.agentIconUrl,
            maCodename: data.maCodename,
            maAgentName: data.maAgentName,
            maInvocationId: data.maInvocationId,
            createdAt: data.createdAt ?? Date.now(),
            sequence: data.sequence,
        })

        if (data.conversationId === activeConversationId.value) {
            currentStreamId.value = data.streamId
            isStreaming.value = true

            // Reset the turn message tracker for the new primary turn
            currentTurnMsgs.length = 0

            const existingMsg = findStreamingMsg(data.streamId)
            if (existingMsg) {
                existingMsg.isStreaming = false
                if (!existingMsg.content && !existingMsg.thinking && !existingMsg.imageDataUrls?.length && !existingMsg.videoDataUrls?.length) {
                    const idx = messages.value.indexOf(existingMsg)
                    if (idx !== -1) messages.value.splice(idx, 1)
                }
            }

            streamingContent.value = ''
            streamingThinking.value = ''
            const reusableMsg = findReusableStreamingPlaceholder()
            if (reusableMsg) {
                reusableMsg.streamId = data.streamId
                reusableMsg.agentId = data.agentId
                reusableMsg.agentName = data.agentName
                reusableMsg.agentIconUrl = data.agentIconUrl
                reusableMsg.maCodename = data.maCodename
                reusableMsg.maAgentName = data.maAgentName
                reusableMsg.maInvocationId = data.maInvocationId
                reusableMsg.createdAt = data.createdAt ?? Date.now()
                reusableMsg.sequence = data.sequence
                currentTurnMsgs.push(reusableMsg)
            } else {
                messages.value.push({
                    id: `streaming_${data.streamId}`,
                    sequence: data.sequence,
                    role: 'assistant',
                    content: '',
                    streamId: data.streamId,
                    agentId: data.agentId,
                    agentName: data.agentName,
                    agentIconUrl: data.agentIconUrl,
                    maCodename: data.maCodename,
                    maAgentName: data.maAgentName,
                    maInvocationId: data.maInvocationId,
                    createdAt: data.createdAt ?? Date.now(),
                    isStreaming: true
                })

                const streamingMsg = messages.value[messages.value.length - 1]
                if (streamingMsg && streamingMsg.isStreaming) {
                    currentTurnMsgs.push(streamingMsg)
                }
            }
        }
    }

    function handleStreamChunk(data: { streamId: string; conversationId: string; content: string }): void {
        const buf = streamBuffers.get(data.conversationId)
        if (buf?.streamId !== data.streamId) return
        buf.content += data.content

        if (data.conversationId === activeConversationId.value) {
            streamingContent.value += data.content
            const streamMsg = findStreamingMsg(data.streamId)
            if (streamMsg) {
                streamMsg.content = streamingContent.value
            }
        }
    }

    function handleStreamThinking(data: { streamId: string; conversationId: string; thinking: string }): void {
        const buf = streamBuffers.get(data.conversationId)
        if (buf?.streamId !== data.streamId) return
        buf.thinking += data.thinking

        if (data.conversationId === activeConversationId.value) {
            streamingThinking.value += data.thinking
            const streamMsg = findStreamingMsg(data.streamId)
            if (streamMsg) {
                streamMsg.thinking = streamingThinking.value
            }
        }
    }

    function handleStreamImages(data: { streamId: string; conversationId: string; images: string[] }): void {
        const buf = streamBuffers.get(data.conversationId)
        if (buf?.streamId !== data.streamId) return
        const existing = new Set(buf.images)
        for (const image of data.images) {
            if (!existing.has(image)) {
                existing.add(image)
                buf.images.push(image)
            }
        }

        if (data.conversationId === activeConversationId.value) {
            const streamMsg = findStreamingMsg(data.streamId)
            if (streamMsg) {
                appendUniqueImages(streamMsg, data.images)
            }
        }
    }

    function handleStreamVideos(data: { streamId: string; conversationId: string; videos: string[] }): void {
        const buf = streamBuffers.get(data.conversationId)
        if (buf?.streamId !== data.streamId) return
        const existing = new Set(buf.videos)
        for (const video of data.videos) {
            if (!existing.has(video)) {
                existing.add(video)
                buf.videos.push(video)
            }
        }

        if (data.conversationId === activeConversationId.value) {
            const streamMsg = findStreamingMsg(data.streamId)
            if (streamMsg) {
                appendUniqueVideos(streamMsg, data.videos)
            }
        }
    }

    function handleStreamReset(data: { streamId: string; conversationId: string }): void {
        let buf = streamBuffers.get(data.conversationId)
        if (buf && buf.streamId !== data.streamId) return
        if (buf) {
            buf.content = ''
            buf.thinking = ''
            buf.images = []
            buf.videos = []
            buf.createdAt = Date.now()
        } else {
            buf = {
                streamId: data.streamId, conversationId: data.conversationId, content: '', thinking: '', images: [], videos: [], active: true,
                createdAt: Date.now()
            }
            streamBuffers.set(data.conversationId, buf)
        }

        if (data.conversationId === activeConversationId.value) {
            streamingContent.value = ''
            streamingThinking.value = ''
            currentStreamId.value = data.streamId
            isStreaming.value = true
            const streamMsg = findStreamingMsg(data.streamId)
            if (streamMsg) {
                if (streamMsg.content || streamMsg.thinking || streamMsg.imageDataUrls?.length || streamMsg.videoDataUrls?.length) {
                    streamMsg.isStreaming = false
                    const newMsg: DisplayMessage = {
                        id: `streaming_${Date.now()}`,
                        role: 'assistant',
                        content: '',
                        streamId: data.streamId,
                        agentId: buf.agentId,
                        agentName: buf.agentName,
                        agentIconUrl: buf.agentIconUrl,
                        maCodename: buf.maCodename,
                        maAgentName: buf.maAgentName,
                        maInvocationId: buf.maInvocationId,
                        createdAt: Date.now(),
                        isStreaming: true
                    }
                    messages.value.push(newMsg)
                    currentTurnMsgs.push(newMsg)
                } else {
                    // Update createdAt so unifiedTimeline sorts this message
                    // after tool-group and sub-agent entries that appeared
                    // during tool execution (they have earlier timestamps).
                    streamMsg.content = ''
                    streamMsg.createdAt = Date.now()
                }
            } else {
                const newMsg: DisplayMessage = {
                    id: `streaming_${Date.now()}`,
                    role: 'assistant',
                    content: '',
                    streamId: data.streamId,
                    agentId: buf.agentId,
                    agentName: buf.agentName,
                    agentIconUrl: buf.agentIconUrl,
                    maCodename: buf.maCodename,
                    maAgentName: buf.maAgentName,
                    maInvocationId: buf.maInvocationId,
                    createdAt: Date.now(),
                    isStreaming: true
                }
                messages.value.push(newMsg)
                currentTurnMsgs.push(newMsg)
            }
        }
    }

    function handleStreamDiscard(data: { streamId: string; conversationId: string }): void {
        const buf = streamBuffers.get(data.conversationId)
        if (buf?.streamId === data.streamId) {
            buf.content = ''
            buf.thinking = ''
            buf.images = []
            buf.videos = []
        }
        if (data.conversationId !== activeConversationId.value) return
        const streamMsg = findStreamingMsg(data.streamId)
        if (streamMsg) {
            const idx = messages.value.indexOf(streamMsg)
            if (idx !== -1) messages.value.splice(idx, 1)
        }
        streamingContent.value = ''
        streamingThinking.value = ''
    }

    function handleStreamUsage(data: { conversationId: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number }; model?: string; contextWindow?: number; contextTokens?: number }): void {
        if (data.conversationId !== activeConversationId.value) return
        lastUsage.value = { ...data.usage, model: data.model, contextTokens: data.contextTokens }
        if (data.contextWindow) {
            contextWindow.value = data.contextWindow
        }
    }

    function handleStreamEnd(data: {
        streamId: string; conversationId: string; cancelled?: boolean
        usage?: { promptTokens: number; completionTokens: number; totalTokens: number }; model?: string; contextWindow?: number
        contextTokens?: number; images?: string[]
    }): void {
        const buf = streamBuffers.get(data.conversationId)
        if (buf && buf.streamId !== data.streamId) return
        if (buf?.streamId === data.streamId) streamBuffers.delete(data.conversationId)

        if (data.conversationId === activeConversationId.value && data.streamId === primaryStreamId.value) {
            primaryStreamId.value = null
            primaryStreamAgent.value = {}
        }

        if (data.conversationId === activeConversationId.value) {
            isStreaming.value = false
            currentStreamId.value = null

            const streamMsg = findStreamingMsg(data.streamId)
            if (streamMsg) {
                streamMsg.isStreaming = false
                streamMsg.model = data.model
                if (data.usage) {
                    streamMsg.promptTokens = data.usage.promptTokens
                    streamMsg.completionTokens = data.usage.completionTokens
                }
                if (data.contextTokens != null) {
                    streamMsg.contextTokens = data.contextTokens
                }
                if (data.images?.length) {
                    appendUniqueImages(streamMsg, data.images)
                }
                if (!hasVisibleContent(streamMsg)) {
                    // A completed round may contain only tool calls. Those calls
                    // are rendered in the execution timeline, so the assistant
                    // placeholder has nothing useful to show. Actual failures
                    // arrive separately through handleStreamError.
                    const idx = messages.value.indexOf(streamMsg)
                    if (idx !== -1) messages.value.splice(idx, 1)
                }
            }

            // Back-fill the model on all earlier round messages from this turn
            // (they were completed via stream-reset without model info).
            if (data.model) {
                for (const msg of currentTurnMsgs) {
                    if (!msg.model) msg.model = data.model
                }
            }
            currentTurnMsgs.length = 0

            if (data.usage) {
                lastUsage.value = { ...data.usage, model: data.model, contextTokens: data.contextTokens }
            }
            if (data.contextWindow) {
                contextWindow.value = data.contextWindow
            }
            streamingContent.value = ''
            streamingThinking.value = ''
        }
    }

    function handleStreamError(data: { streamId: string; conversationId: string; error: string }): void {
        const buf = streamBuffers.get(data.conversationId)
        if (buf && buf.streamId !== data.streamId) return
        if (buf?.streamId === data.streamId) streamBuffers.delete(data.conversationId)

        if (data.conversationId === activeConversationId.value && data.streamId === primaryStreamId.value) {
            primaryStreamId.value = null
            primaryStreamAgent.value = {}
        }

        if (data.conversationId === activeConversationId.value) {
            isStreaming.value = false
            currentStreamId.value = null

            // The server has already stored this error and published it as a
            // transcript message. Finish the temporary stream without adding
            // another browser-only error bubble.
            if (messages.value.some(msg => msg.isError && msg.streamId === data.streamId && msg.content === data.error)) {
                const pending = findStreamingMsg(data.streamId)
                if (pending) {
                    pending.isStreaming = false
                    if (pending.id.startsWith('streaming_')) messages.value.splice(messages.value.indexOf(pending), 1)
                }
                return
            }

            const streamMsg = findStreamingMsg(data.streamId)
            if (streamMsg) {
                streamMsg.isStreaming = false
                if (streamMsg.videoDataUrls?.length) {
                    pushStreamErrorMessage(data.error)
                } else {
                    streamMsg.isError = true
                    streamMsg.content = data.error
                }
            } else {
                const previousMsg = findMsgByStreamId(data.streamId)
                if (previousMsg && !hasVisibleContent(previousMsg)) {
                    previousMsg.isError = true
                    previousMsg.content = data.error
                } else {
                    pushStreamErrorMessage(data.error)
                }
            }
        }
    }

    function handleSubAgentStreamStart(data: { streamId: string; conversationId: string; sequence?: number; createdAt?: number; agentId?: string; agentName?: string; agentIconUrl?: string | null; maCodename?: string; maAgentName?: string; maInvocationId?: string }): void {
        const key = scopedStreamKey(data.conversationId, data.streamId)
        subAgentStreamBuffers.set(key, {
            streamId: data.streamId,
            conversationId: data.conversationId,
            content: '',
            thinking: '',
            images: [],
            videos: [],
            active: true,
            agentId: data.agentId,
            agentName: data.agentName,
            agentIconUrl: data.agentIconUrl,
            maCodename: data.maCodename,
            maAgentName: data.maAgentName,
            maInvocationId: data.maInvocationId,
            createdAt: data.createdAt ?? Date.now(),
            sequence: data.sequence,
        })

        if (data.conversationId !== activeConversationId.value) return

        const existingMsg = subAgentStreamMsgs.get(key)
        if (existingMsg) {
            existingMsg.isStreaming = false
            if (!existingMsg.content && !existingMsg.thinking && !existingMsg.imageDataUrls?.length && !existingMsg.videoDataUrls?.length) {
                const idx = messages.value.indexOf(existingMsg)
                if (idx !== -1) messages.value.splice(idx, 1)
            }
            subAgentStreamMsgs.delete(key)
        }

        const msg: DisplayMessage = {
            id: `sa_stream_${data.streamId}`,
            sequence: data.sequence,
            role: 'assistant',
            content: '',
            streamId: data.streamId,
            agentId: data.agentId,
            agentName: data.agentName,
            agentIconUrl: data.agentIconUrl,
            maCodename: data.maCodename,
            maAgentName: data.maAgentName,
            maInvocationId: data.maInvocationId,
            createdAt: data.createdAt ?? Date.now(),
            isStreaming: true
        }
        messages.value.push(msg)
        subAgentStreamMsgs.set(key, msg)
    }

    function handleSubAgentStreamChunk(data: { streamId: string; conversationId: string; content: string }): void {
        const buf = subAgentStreamBuffers.get(scopedStreamKey(data.conversationId, data.streamId))
        if (buf && buf.conversationId === data.conversationId) {
            buf.content += data.content
        }

        if (data.conversationId !== activeConversationId.value) return
        const msg = subAgentStreamMsgs.get(scopedStreamKey(data.conversationId, data.streamId))
        if (msg) {
            msg.content += data.content
        }
    }

    function handleSubAgentStreamThinking(data: { streamId: string; conversationId: string; thinking: string }): void {
        const buf = subAgentStreamBuffers.get(scopedStreamKey(data.conversationId, data.streamId))
        if (buf && buf.conversationId === data.conversationId) {
            buf.thinking += data.thinking
        }

        if (data.conversationId !== activeConversationId.value) return
        const msg = subAgentStreamMsgs.get(scopedStreamKey(data.conversationId, data.streamId))
        if (msg) {
            msg.thinking = (msg.thinking || '') + data.thinking
        }
    }

    function handleSubAgentStreamImages(data: { streamId: string; conversationId: string; images: string[] }): void {
        const buf = subAgentStreamBuffers.get(scopedStreamKey(data.conversationId, data.streamId))
        if (buf && buf.conversationId === data.conversationId) {
            const existing = new Set(buf.images)
            for (const image of data.images) {
                if (!existing.has(image)) {
                    existing.add(image)
                    buf.images.push(image)
                }
            }
        }

        if (data.conversationId !== activeConversationId.value) return
        const msg = subAgentStreamMsgs.get(scopedStreamKey(data.conversationId, data.streamId))
        if (msg) {
            appendUniqueImages(msg, data.images)
        }
    }

    function handleSubAgentStreamEnd(data: { streamId: string; conversationId: string; cancelled?: boolean; model?: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }): void {
        const key = scopedStreamKey(data.conversationId, data.streamId)
        const buf = subAgentStreamBuffers.get(key)
        if (buf && buf.conversationId === data.conversationId) {
            buf.active = false
            subAgentStreamBuffers.delete(key)
        }

        if (data.conversationId !== activeConversationId.value) return
        const msg = subAgentStreamMsgs.get(key)
        if (msg) {
            msg.isStreaming = false
            if (data.cancelled) {
                const idx = messages.value.indexOf(msg)
                if (idx !== -1) messages.value.splice(idx, 1)
                subAgentStreamMsgs.delete(key)
                lastCompletedSubAgentMsgs.delete(key)
                return
            }
            if (data.model) {
                msg.model = data.model
            }
            if (data.usage) {
                msg.promptTokens = data.usage.promptTokens
                msg.completionTokens = data.usage.completionTokens
            }
            if (!msg.content && !msg.thinking && !msg.imageDataUrls?.length && !msg.videoDataUrls?.length) {
                const idx = messages.value.indexOf(msg)
                if (idx !== -1) messages.value.splice(idx, 1)
            } else {
                lastCompletedSubAgentMsgs.set(key, msg)
            }
            subAgentStreamMsgs.delete(key)
        } else if (lastCompletedSubAgentMsgs.has(key) && (data.model || data.usage)) {
            // Final subagent-stream-end from run() arrives after per-round ends already cleared the stream message.
            // Apply the model/usage to the last completed sub-agent message.
            const completedMsg = lastCompletedSubAgentMsgs.get(key)!
            if (data.model) {
                completedMsg.model = data.model
            }
            if (data.usage) {
                completedMsg.promptTokens = data.usage.promptTokens
                completedMsg.completionTokens = data.usage.completionTokens
            }
            lastCompletedSubAgentMsgs.delete(key)
        }
    }

    function handleTitleUpdated(data: { conversationId: string; title: string }): void {
        const conv = conversations.value.find((c) => c.id === data.conversationId)
        if (conv) {
            conv.title = data.title
            if (data.conversationId === activeConversationId.value) {
                conv.lastReadAt = Math.max(Date.now(), conv.updatedAt || 0, conv.lastReadAt || 0)
                api.chat.markConversationRead(data.conversationId).catch(() => { /* non-critical */ })
            }
        }
    }


    function handleNewMessage(data: {
        streamId?: string
        conversationId: string
        message: {
            id: string
            conversationId: string
            sequence?: number
            toolCallIds?: string[]
            role: string
            isError?: boolean
            content: string
            thinking?: string
            createdAt: number
            imageDataUrls?: string[]
            videoDataUrls?: string[]
            audioDataUrls?: string[]
            structuredContent?: unknown
            fileAttachments?: { name: string; href?: string }[]
            agentId?: string
            agentName?: string
            agentIconUrl?: string | null
            maCodename?: string
            maAgentName?: string
            maInvocationId?: string
        }
    }): void {
        function hydratePersisted(target: DisplayMessage): void {
            if (data.message.sequence !== undefined) target.sequence = data.message.sequence
            if (data.message.toolCallIds) target.toolCallIds = data.message.toolCallIds
            target.isError = data.message.isError
            target.content = data.message.content
            if (data.message.thinking !== undefined) target.thinking = data.message.thinking
            if (data.message.imageDataUrls) target.imageDataUrls = data.message.imageDataUrls
            if (data.message.videoDataUrls) target.videoDataUrls = data.message.videoDataUrls
            if (data.message.audioDataUrls) target.audioDataUrls = data.message.audioDataUrls
            if (data.message.structuredContent !== undefined) target.structuredContent = data.message.structuredContent
            if (data.message.fileAttachments?.length) {
                for (const attachment of target.fileAttachments || []) {
                    if (attachment.href?.startsWith('blob:')) URL.revokeObjectURL(attachment.href)
                }
                target.fileAttachments = data.message.fileAttachments
            }
        }
        // Bump updatedAt so the conversation shows as recently updated / unread
        const conv = conversations.value.find(c => c.id === data.conversationId)
        if (conv) {
            conv.updatedAt = Date.now()
            // If the user is currently viewing this conversation, mark it as seen
            if (data.conversationId === activeConversationId.value) {
                conv.lastReadAt = conv.updatedAt
                api.chat.markConversationRead(data.conversationId).catch(() => { /* non-critical */ })
            }
        }
        if (data.conversationId === activeConversationId.value) {
            const existing = messages.value.find(message => message.id === data.message.id)
            if (existing) {
                hydratePersisted(existing)
                return
            }
            // Replace the temporary round ID with the persisted ID before actions
            // such as forking can address this message on the server.
            if (data.streamId && data.message.role === 'assistant' && !data.message.isError) {
                const round = findMsgByStreamId(data.streamId)
                if (round) {
                    round.id = data.message.id
                    hydratePersisted(round)
                    return
                }
            }
            if (!messages.value.some(m => m.id === data.message.id)) {
                messages.value.push({
                    id: data.message.id,
                    sequence: data.message.sequence,
                    toolCallIds: data.message.toolCallIds,
                    role: data.message.role as DisplayMessage['role'],
                    isError: data.message.isError,
                    streamId: data.message.role === 'assistant' ? data.streamId : undefined,
                    content: data.message.content,
                    thinking: data.message.thinking,
                    imageDataUrls: data.message.imageDataUrls,
                    videoDataUrls: data.message.videoDataUrls,
                    audioDataUrls: data.message.audioDataUrls,
                    structuredContent: data.message.structuredContent,
                    fileAttachments: data.message.fileAttachments,
                    agentId: data.message.agentId,
                    agentName: data.message.agentName,
                    agentIconUrl: data.message.agentIconUrl,
                    maCodename: data.message.maCodename,
                    maAgentName: data.message.maAgentName,
                    maInvocationId: data.message.maInvocationId,
                    createdAt: data.message.createdAt
                })
            }
        }
    }

    function handleCompactEvent(data: { conversationId: string; messageId: string; summary: string; compactedMessageCount: number; model: string; createdAt: number }): void {
        if (data.conversationId !== activeConversationId.value) return
        // Avoid duplicates (e.g. if page reloads and event re-fires)
        if (messages.value.some(m => m.id === data.messageId)) return
        // Remove any pending compact placeholder
        const pendingIdx = messages.value.findIndex(m => m.id === `compact-pending-${data.conversationId}`)
        if (pendingIdx !== -1) messages.value.splice(pendingIdx, 1)
        messages.value.push({
            id: data.messageId,
            role: 'system',
            content: `[CONTEXT_COMPACT_EVENT] ${JSON.stringify({ summary: data.summary, compactedMessageCount: data.compactedMessageCount, model: data.model, createdAt: data.createdAt })}`,
            compactEventData: { summary: data.summary, compactedMessageCount: data.compactedMessageCount, model: data.model, createdAt: data.createdAt },
            createdAt: data.createdAt,
        })
    }

    function handleCompactStart(data: { conversationId: string }): void {
        if (data.conversationId !== activeConversationId.value) return
        const pendingId = `compact-pending-${data.conversationId}`
        if (messages.value.some(m => m.id === pendingId)) return
        messages.value.push({
            id: pendingId,
            role: 'system',
            content: '',
            compactEventData: { summary: '', compactedMessageCount: 0, model: '', createdAt: Date.now() },
            createdAt: Date.now(),
        })
    }

    function handleCompactError(data: { conversationId: string }): void {
        if (data.conversationId !== activeConversationId.value) return
        const pendingIdx = messages.value.findIndex(m => m.id === `compact-pending-${data.conversationId}`)
        if (pendingIdx !== -1) messages.value.splice(pendingIdx, 1)
    }

    return {
        isStreaming,
        currentStreamId,
        streamingContent,
        streamingThinking,
        lastUsage,
        primaryStreamId,
        primaryStreamAgent,
        streamBuffers,
        subAgentStreamBuffers,
        clearConversationStreamState,
        findStreamingMsg,
        restorePrimaryStream,
        restoreSubAgentStreams,
        finalizeCurrentStreaming,
        handleStreamStart,
        handleStreamChunk,
        handleStreamThinking,
        handleStreamImages,
        handleStreamVideos,
        handleStreamReset,
        handleStreamDiscard,
        handleStreamUsage,
        handleStreamEnd,
        handleStreamError,
        handleSubAgentStreamStart,
        handleSubAgentStreamChunk,
        handleSubAgentStreamThinking,
        handleSubAgentStreamImages,
        handleSubAgentStreamEnd,
        handleTitleUpdated,
        handleNewMessage,
        handleCompactEvent,
        handleCompactStart,
        handleCompactError,
    }
}
