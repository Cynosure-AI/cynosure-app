import { type Ref } from 'vue'
import { api } from '../api/client'
import { useAgentStore } from '../stores/agent-runtime.store'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { usePreferencesStore } from '../stores/preferences.store'
import type { SubAgentAssignment } from '../api/types'
import type { DisplayMessage } from '../stores/chat.store'
import type { ChatStreamingState } from './useChatStreaming'
import type { ChatAttachmentInput, ChatQueueDelivery, ChatQueueRequest, ChatSendRequest, ReasoningEffort } from '@shared/types'

export interface ChatMessagesApi {
    sendMessage(content: string, imageDataUrls?: string[], files?: ChatAttachmentInput[], audioDataUrls?: string[]): Promise<void>
    queueMessage(content: string, delivery: ChatQueueDelivery, imageDataUrls?: string[], files?: ChatAttachmentInput[], audioDataUrls?: string[]): Promise<void>
    updateQueuedMessage(id: string, content: string, imageDataUrls?: string[], files?: ChatAttachmentInput[], audioDataUrls?: string[]): Promise<void>
    retryFromMessage(messageId: string): Promise<void>
    editMessage(messageId: string, newContent: string): Promise<void>
    cancelStream(): Promise<void>
    cancelPostActions(convId?: string): void
}

export function useChatMessages(
    activeConversationId: Ref<string | null>,
    activeAgentId: Ref<string | null>,
    messages: Ref<DisplayMessage[]>,
    streaming: ChatStreamingState,
    createConversation: () => Promise<string>,
    agentConfig: {
        sessionModelOverride: Ref<string | null>
        sessionProviderOverride: Ref<string | null>
        sessionSystemPrompt: Ref<string>
        sessionThinkingEnabled: Ref<boolean>
        sessionReasoningEffort: Ref<ReasoningEffort>
        sessionAutoToolRouting: Ref<boolean>
        sessionAutoMemory: Ref<boolean>
        selectedToolNames: Ref<string[]>
        freeChatSubAgentIds: Ref<string[]>
        freeChatMemoryFolderIds: Ref<string[]>
        freeChatMemorySelectionInitialized: Ref<boolean>
    },
): ChatMessagesApi {
    const agentStore = useAgentStore()

    function createMessageId(): string {
        if (typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID()
        }

        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
            const value = crypto.getRandomValues(new Uint8Array(1))[0] & 15
            const nibble = char === 'x' ? value : (value & 3) | 8
            return nibble.toString(16)
        })
    }

    function buildSubAgentAssignments(parentAgentId: string | null, selectedIds: string[]): SubAgentAssignment[] {
        return selectedIds.map((id) => ({
            agentId: id,
        }))
    }

    function activeConversationIsRunning(): boolean {
        const conversationId = activeConversationId.value
        return Boolean(conversationId && agentStore.isConversationExecuting(conversationId))
    }

    function createFilePreviewUrl(content: string): string | undefined {
        if (typeof URL.createObjectURL !== 'function') return undefined

        try {
            if (!content.startsWith('data:')) {
                return URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }))
            }

            const commaIndex = content.indexOf(',')
            if (commaIndex === -1) return undefined
            const metadata = content.slice(5, commaIndex)
            const mimeType = metadata.split(';')[0] || 'application/octet-stream'
            const payload = content.slice(commaIndex + 1)
            if (!metadata.includes(';base64')) {
                return URL.createObjectURL(new Blob([decodeURIComponent(payload)], { type: mimeType }))
            }

            const binary = atob(payload)
            const bytes = new Uint8Array(binary.length)
            for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
            return URL.createObjectURL(new Blob([bytes], { type: mimeType }))
        } catch {
            return undefined
        }
    }

    function buildRequest(
        content: string,
        msgId: string,
        imageDataUrls?: string[],
        files?: ChatAttachmentInput[],
        audioDataUrls?: string[],
    ): ChatSendRequest {
        const agentDefs = useAgentDefinitionsStore()
        const activeAgent = activeAgentId.value ? agentDefs.get(activeAgentId.value) : null
        const prefs = usePreferencesStore()
        return {
            content,
            messageId: msgId,
            imageDataUrls,
            audioDataUrls,
            files,
            run: {
                model: agentConfig.sessionModelOverride.value || undefined,
                providerOverride: agentConfig.sessionProviderOverride.value || undefined,
                allowedTools: agentConfig.selectedToolNames.value,
                systemPrompt: agentConfig.sessionSystemPrompt.value || activeAgent?.systemPrompt || undefined,
                generateTitle: prefs.generateTitle,
                generateQuickResponses: prefs.quickResponses,
                subAgents: buildSubAgentAssignments(activeAgentId.value, [...agentConfig.freeChatSubAgentIds.value]),
                memoryFolderIds: agentConfig.freeChatMemorySelectionInitialized.value ? [...agentConfig.freeChatMemoryFolderIds.value] : undefined,
                thinkingEnabled: agentConfig.sessionThinkingEnabled.value,
                reasoningEffort: agentConfig.sessionReasoningEffort.value,
                contextStrategy: prefs.contextStrategy,
                titleProviderId: prefs.titleProviderId || undefined,
                titleModel: prefs.titleModel || undefined,
                autoToolRouting: agentConfig.sessionAutoToolRouting.value,
                autoMemory: agentConfig.sessionAutoMemory.value,
                autoRouterProviderId: activeAgent?.autoRouterProviderId || undefined,
                autoRouterModel: activeAgent?.autoRouterModel || undefined,
                compactProviderId: prefs.compactProviderId || undefined,
                compactModel: prefs.compactModel || undefined,
                inlineAttachmentTextLimit: prefs.inlineAttachmentTextLimit,
                debugMode: prefs.debugMode,
            },
        }
    }

    async function queueMessage(
        content: string,
        delivery: ChatQueueDelivery,
        imageDataUrls?: string[],
        files?: ChatAttachmentInput[],
        audioDataUrls?: string[],
    ): Promise<void> {
        if (!activeConversationId.value) await createConversation()
        const request: ChatQueueRequest = {
            ...buildRequest(content, createMessageId(), imageDataUrls, files, audioDataUrls),
            delivery,
        }
        await api.chat.enqueue(activeConversationId.value!, request)
    }

    async function updateQueuedMessage(
        id: string,
        content: string,
        imageDataUrls?: string[],
        files?: ChatAttachmentInput[],
        audioDataUrls?: string[],
    ): Promise<void> {
        if (!activeConversationId.value) return
        const request: ChatQueueRequest = {
            ...buildRequest(content, id, imageDataUrls, files, audioDataUrls),
            delivery: 'next',
        }
        await api.chat.updateQueued(activeConversationId.value, id, request)
    }

    async function sendMessage(
        content: string,
        imageDataUrls?: string[],
        files?: ChatAttachmentInput[],
        audioDataUrls?: string[]
    ): Promise<void> {
        if (!activeConversationId.value) {
            await createConversation()
        }

        const conversationId = activeConversationId.value!
        const msgId = createMessageId()

        messages.value.push({
            id: msgId,
            role: 'user',
            content,
            imageDataUrls,
            audioDataUrls,
            fileAttachments: files?.map((file) => {
                const href = file.content ? createFilePreviewUrl(file.content) : undefined
                return href ? { name: file.name, href } : { name: file.name }
            }),
            createdAt: Date.now()
        })

        agentStore.clearExecutionState()
        agentStore.prepareConversationExecution(conversationId)

        streaming.streamingContent.value = ''
        streaming.streamingThinking.value = ''
        streaming.isStreaming.value = true
        streaming.primaryStreamId.value = msgId

        const agentDefs = useAgentDefinitionsStore()
        const activeAgent = activeAgentId.value ? agentDefs.get(activeAgentId.value) : null
        messages.value.push({
            id: `streaming_${Date.now()}`,
            role: 'assistant',
            content: '',
            agentName: activeAgent?.name,
            agentIconUrl: activeAgent?.iconUrl ?? undefined,
            createdAt: Date.now(),
            isStreaming: true
        })

        const request = buildRequest(content, msgId, imageDataUrls, files, audioDataUrls)

        try {
            await api.chat.send(conversationId, request)
            agentStore.setConversationExecutionState(conversationId, false)
        } catch (err) {
            agentStore.setConversationExecutionState(conversationId, false)
            streaming.clearConversationStreamState(conversationId)
            throw err
        }
    }

    async function retryFromMessage(messageId: string): Promise<void> {
        if (!activeConversationId.value || activeConversationIsRunning()) return
        const conversationId = activeConversationId.value
        const idx = messages.value.findIndex(m => m.id === messageId)
        if (idx === -1) return
        const msg = messages.value[idx]
        if (msg.role !== 'user') return
        const attachments = await api.chat.getMessageAttachments(conversationId, messageId)
        await api.chat.truncateFrom(conversationId, messageId)
        messages.value.splice(idx)
        streaming.clearConversationStreamState(conversationId)
        agentStore.truncateConversationExecution(conversationId, msg.createdAt)
        await sendMessage(msg.content, attachments.imageDataUrls, attachments.files, attachments.audioDataUrls)
    }

    async function editMessage(messageId: string, newContent: string): Promise<void> {
        if (!activeConversationId.value || activeConversationIsRunning()) return
        const conversationId = activeConversationId.value
        const idx = messages.value.findIndex(m => m.id === messageId)
        if (idx === -1) return
        const msg = messages.value[idx]
        if (msg.role !== 'user') return
        const attachments = await api.chat.getMessageAttachments(conversationId, messageId)
        await api.chat.truncateFrom(conversationId, messageId)
        messages.value.splice(idx)
        streaming.clearConversationStreamState(conversationId)
        agentStore.truncateConversationExecution(conversationId, msg.createdAt)
        await sendMessage(newContent, attachments.imageDataUrls, attachments.files, attachments.audioDataUrls)
    }

    async function cancelStream(): Promise<void> {
        const id = streaming.primaryStreamId.value || streaming.currentStreamId.value
        const convId = activeConversationId.value
        // Ask the server first. Clearing local state before this request succeeds
        // hides the Stop button while the execution may still be running.
        const result = id || convId
            ? await api.chat.cancelStream(id || '', convId || undefined)
            : { success: true, executionIds: [] as string[] }
        if (convId) {
            agentStore.stopConversationExecution(convId, [...new Set([
                ...(id ? [id] : []), ...result.executionIds,
            ])])
            streaming.clearConversationStreamState(convId)
            cancelPostActions(convId)
        } else {
            streaming.isStreaming.value = false
            streaming.currentStreamId.value = null
            streaming.primaryStreamId.value = null
            streaming.primaryStreamAgent.value = {}
            const streamMsg = streaming.findStreamingMsg(id || undefined)
            if (streamMsg) {
                streamMsg.isStreaming = false
                if (!streamMsg.content && !streamMsg.thinking) {
                    const idx = messages.value.indexOf(streamMsg)
                    if (idx !== -1) messages.value.splice(idx, 1)
                }
            }
            streaming.streamingContent.value = ''
            streaming.streamingThinking.value = ''
        }

    }

    function cancelPostActions(convId?: string): void {
        const id = convId || activeConversationId.value
        if (!id) return
        api.chat.cancelPostActions(id).catch(() => { })
    }

    return {
        sendMessage,
        queueMessage,
        updateQueuedMessage,
        retryFromMessage,
        editMessage,
        cancelStream,
        cancelPostActions,
    }
}
