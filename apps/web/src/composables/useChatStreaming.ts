import { ref, type Ref } from 'vue'
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
    content: string
    thinking: string
    images: string[]
    active: boolean
    agentId?: string
    agentName?: string
    agentIconUrl?: string | null
    createdAt: number
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
    findStreamingMsg(): DisplayMessage | undefined
    finalizeCurrentStreaming(conversationId: string): void
    handleStreamStart(data: { streamId: string; conversationId: string; agentId?: string; agentName?: string; agentIconUrl?: string | null }): void
    handleStreamChunk(data: { streamId: string; conversationId: string; content: string }): void
    handleStreamThinking(data: { streamId: string; conversationId: string; thinking: string }): void
    handleStreamImages(data: { streamId: string; conversationId: string; images: string[] }): void
    handleStreamReset(data: { streamId: string; conversationId: string }): void
    handleStreamUsage(data: { conversationId: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number }; model?: string; contextWindow?: number; contextTokens?: number }): void
    handleStreamEnd(data: { streamId: string; conversationId: string; cancelled?: boolean; usage?: { promptTokens: number; completionTokens: number; totalTokens: number }; model?: string; contextWindow?: number; contextTokens?: number; images?: string[] }): void
    handleStreamError(data: { streamId: string; conversationId: string; error: string }): void
    handleSubAgentStreamStart(data: { streamId: string; conversationId: string; agentId?: string; agentName?: string; agentIconUrl?: string | null }): void
    handleSubAgentStreamChunk(data: { streamId: string; conversationId: string; content: string }): void
    handleSubAgentStreamThinking(data: { streamId: string; conversationId: string; thinking: string }): void
    handleSubAgentStreamImages(data: { streamId: string; conversationId: string; images: string[] }): void
    handleSubAgentStreamEnd(data: { streamId: string; conversationId: string; model?: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }): void
    handleTitleUpdated(data: { conversationId: string; title: string }): void
    handleNewMessage(data: { conversationId: string; message: { id: string; conversationId: string; role: string; content: string; createdAt: number; agentId?: string; agentName?: string; agentIconUrl?: string | null } }): void
    handleCompactEvent(data: { conversationId: string; messageId: string; summary: string; compactedMessageCount: number; model: string; createdAt: number }): void
    handleCompactStart(data: { conversationId: string }): void
    handleCompactError(data: { conversationId: string; error: string }): void
}

export function useChatStreaming(
    activeConversationId: Ref<string | null>,
    messages: Ref<DisplayMessage[]>,
    conversations: Ref<{ id: string; title: string }[]>,
    contextWindow: Ref<number | null>,
): ChatStreamingState {
    const isStreaming = ref(false)
    const currentStreamId = ref<string | null>(null)
    const streamingContent = ref('')
    const streamingThinking = ref('')
    const lastUsage = ref<TokenUsage | null>(null)
    const primaryStreamId = ref<string | null>(null)
    const primaryStreamAgent = ref<{ agentId?: string; agentName?: string; agentIconUrl?: string | null }>({})
    const streamBuffers = new Map<string, StreamBuffer>()
    const subAgentStreamMsg = ref<DisplayMessage | null>(null)
    /** Tracks the last completed (non-empty) sub-agent message so the final
     *  subagent-stream-end event (which carries model/usage) can find it
     *  even after subAgentStreamMsg has been nulled. */
    const lastCompletedSubAgentMsg = ref<DisplayMessage | null>(null)
    /** All primary-stream messages created in the current turn (reset on stream-start).
     *  Used to back-fill the model on earlier round messages when stream-end arrives. */
    const currentTurnMsgs: DisplayMessage[] = []

    function findStreamingMsg(): DisplayMessage | undefined {
        for (let i = messages.value.length - 1; i >= 0; i--) {
            if (messages.value[i].isStreaming) return messages.value[i]
        }
        return undefined
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

    function finalizeCurrentStreaming(conversationId: string): void {
        if (conversationId !== activeConversationId.value) return
        const streamMsg = findStreamingMsg()
        if (streamMsg && (streamMsg.content || streamMsg.thinking || streamMsg.imageDataUrls?.length)) {
            streamMsg.isStreaming = false
        }
    }

    function handleStreamStart(data: { streamId: string; conversationId: string; agentId?: string; agentName?: string; agentIconUrl?: string | null }): void {
        if (!primaryStreamId.value) {
            primaryStreamId.value = data.streamId
            primaryStreamAgent.value = { agentId: data.agentId, agentName: data.agentName, agentIconUrl: data.agentIconUrl }
        }

        streamBuffers.set(data.conversationId, {
            streamId: data.streamId,
            content: '',
            thinking: '',
            images: [],
            active: true,
            agentId: data.agentId,
            agentName: data.agentName,
            agentIconUrl: data.agentIconUrl,
            createdAt: Date.now()
        })

        if (data.conversationId === activeConversationId.value) {
            currentStreamId.value = data.streamId
            isStreaming.value = true

            // Reset the turn message tracker for the new primary turn
            currentTurnMsgs.length = 0

            const lastMsg = messages.value[messages.value.length - 1]
            if (lastMsg?.isStreaming) {
                lastMsg.isStreaming = false
                if (!lastMsg.content && !lastMsg.thinking && !lastMsg.imageDataUrls?.length) {
                    messages.value.pop()
                }
            }

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

            const streamingMsg = messages.value[messages.value.length - 1]
            if (streamingMsg && streamingMsg.isStreaming) {
                currentTurnMsgs.push(streamingMsg)
            }
        }
    }

    function handleStreamChunk(data: { streamId: string; conversationId: string; content: string }): void {
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

    function handleStreamThinking(data: { streamId: string; conversationId: string; thinking: string }): void {
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

    function handleStreamImages(data: { streamId: string; conversationId: string; images: string[] }): void {
        const buf = streamBuffers.get(data.conversationId)
        if (buf) {
            const existing = new Set(buf.images)
            for (const image of data.images) {
                if (!existing.has(image)) {
                    existing.add(image)
                    buf.images.push(image)
                }
            }
        }

        if (data.conversationId === activeConversationId.value) {
            const streamMsg = findStreamingMsg()
            if (streamMsg) {
                appendUniqueImages(streamMsg, data.images)
            }
        }
    }

    function handleStreamReset(data: { streamId: string; conversationId: string }): void {
        let buf = streamBuffers.get(data.conversationId)
        if (buf) {
            buf.content = ''
            buf.thinking = ''
            buf.images = []
            buf.createdAt = Date.now()
        } else {
            buf = {
                streamId: data.streamId, content: '', thinking: '', images: [], active: true,
                agentId: primaryStreamAgent.value.agentId,
                agentName: primaryStreamAgent.value.agentName,
                agentIconUrl: primaryStreamAgent.value.agentIconUrl,
                createdAt: Date.now()
            }
            streamBuffers.set(data.conversationId, buf)
        }

        if (data.conversationId === activeConversationId.value) {
            streamingContent.value = ''
            streamingThinking.value = ''
            currentStreamId.value = data.streamId
            isStreaming.value = true
            const streamMsg = findStreamingMsg()
            if (streamMsg) {
                if (streamMsg.content || streamMsg.thinking || streamMsg.imageDataUrls?.length) {
                    streamMsg.isStreaming = false
                    const newMsg: DisplayMessage = {
                        id: `streaming_${Date.now()}`,
                        role: 'assistant',
                        content: '',
                        agentId: primaryStreamAgent.value.agentId,
                        agentName: primaryStreamAgent.value.agentName,
                        agentIconUrl: primaryStreamAgent.value.agentIconUrl,
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
                    agentId: primaryStreamAgent.value.agentId,
                    agentName: primaryStreamAgent.value.agentName,
                    agentIconUrl: primaryStreamAgent.value.agentIconUrl,
                    createdAt: Date.now(),
                    isStreaming: true
                }
                messages.value.push(newMsg)
                currentTurnMsgs.push(newMsg)
            }
        }
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
                if (!data.cancelled && !streamMsg.content && !streamMsg.thinking && !streamMsg.imageDataUrls?.length) {
                    streamMsg.isError = true
                    streamMsg.content = 'No response received from the model.'
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

    function handleSubAgentStreamStart(data: { streamId: string; conversationId: string; agentId?: string; agentName?: string; agentIconUrl?: string | null }): void {
        if (data.conversationId !== activeConversationId.value) return

        if (subAgentStreamMsg.value) {
            subAgentStreamMsg.value.isStreaming = false
            if (!subAgentStreamMsg.value.content && !subAgentStreamMsg.value.thinking && !subAgentStreamMsg.value.imageDataUrls?.length) {
                const idx = messages.value.indexOf(subAgentStreamMsg.value)
                if (idx !== -1) messages.value.splice(idx, 1)
            }
        }

        const msg: DisplayMessage = {
            id: `sa_stream_${Date.now()}`,
            role: 'assistant',
            content: '',
            agentId: data.agentId,
            agentName: data.agentName,
            agentIconUrl: data.agentIconUrl,
            createdAt: Date.now(),
            isStreaming: true
        }
        messages.value.push(msg)
        subAgentStreamMsg.value = msg
    }

    function handleSubAgentStreamChunk(data: { streamId: string; conversationId: string; content: string }): void {
        if (data.conversationId !== activeConversationId.value) return
        if (subAgentStreamMsg.value) {
            subAgentStreamMsg.value.content += data.content
        }
    }

    function handleSubAgentStreamThinking(data: { streamId: string; conversationId: string; thinking: string }): void {
        if (data.conversationId !== activeConversationId.value) return
        if (subAgentStreamMsg.value) {
            subAgentStreamMsg.value.thinking = (subAgentStreamMsg.value.thinking || '') + data.thinking
        }
    }

    function handleSubAgentStreamImages(data: { streamId: string; conversationId: string; images: string[] }): void {
        if (data.conversationId !== activeConversationId.value) return
        if (subAgentStreamMsg.value) {
            appendUniqueImages(subAgentStreamMsg.value, data.images)
        }
    }

    function handleSubAgentStreamEnd(data: { streamId: string; conversationId: string; model?: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }): void {
        if (data.conversationId !== activeConversationId.value) return
        if (subAgentStreamMsg.value) {
            subAgentStreamMsg.value.isStreaming = false
            if (data.model) {
                subAgentStreamMsg.value.model = data.model
            }
            if (data.usage) {
                subAgentStreamMsg.value.promptTokens = data.usage.promptTokens
                subAgentStreamMsg.value.completionTokens = data.usage.completionTokens
            }
            if (!subAgentStreamMsg.value.content && !subAgentStreamMsg.value.thinking && !subAgentStreamMsg.value.imageDataUrls?.length) {
                const idx = messages.value.indexOf(subAgentStreamMsg.value)
                if (idx !== -1) messages.value.splice(idx, 1)
            } else {
                lastCompletedSubAgentMsg.value = subAgentStreamMsg.value
            }
            subAgentStreamMsg.value = null
        } else if (lastCompletedSubAgentMsg.value && (data.model || data.usage)) {
            // Final subagent-stream-end from run() arrives after per-round ends already nulled subAgentStreamMsg.
            // Apply the model/usage to the last completed sub-agent message.
            if (data.model) {
                lastCompletedSubAgentMsg.value.model = data.model
            }
            if (data.usage) {
                lastCompletedSubAgentMsg.value.promptTokens = data.usage.promptTokens
                lastCompletedSubAgentMsg.value.completionTokens = data.usage.completionTokens
            }
            lastCompletedSubAgentMsg.value = null
        }
    }

    function handleTitleUpdated(data: { conversationId: string; title: string }): void {
        const conv = conversations.value.find((c) => c.id === data.conversationId)
        if (conv) {
            conv.title = data.title
        }
    }


    function handleNewMessage(data: {
        conversationId: string
        message: {
            id: string
            conversationId: string
            role: string
            content: string
            createdAt: number
            imageDataUrls?: string[]
            audioDataUrls?: string[]
            fileAttachments?: { name: string }[]
            agentId?: string
            agentName?: string
            agentIconUrl?: string | null
        }
    }): void {
        if (data.conversationId === activeConversationId.value) {
            if (!messages.value.some(m => m.id === data.message.id)) {
                messages.value.push({
                    id: data.message.id,
                    role: data.message.role as DisplayMessage['role'],
                    content: data.message.content,
                    imageDataUrls: data.message.imageDataUrls,
                    audioDataUrls: data.message.audioDataUrls,
                    fileAttachments: data.message.fileAttachments,
                    agentId: data.message.agentId,
                    agentName: data.message.agentName,
                    agentIconUrl: data.message.agentIconUrl,
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
        findStreamingMsg,
        finalizeCurrentStreaming,
        handleStreamStart,
        handleStreamChunk,
        handleStreamThinking,
        handleStreamImages,
        handleStreamReset,
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
