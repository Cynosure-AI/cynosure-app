import { type Ref } from 'vue'
import { api } from '../api/client'
import { useAgentStore } from '../stores/agent-runtime.store'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { usePreferencesStore } from '../stores/preferences.store'
import type { SubAgentAssignment } from '../api/types'
import type { DisplayMessage } from '../stores/chat.store'
import type { ChatStreamingState } from './useChatStreaming'
import type { ChatSendRequest, ReasoningEffort } from '@shared/types'

export interface ChatMessagesApi {
    sendMessage(content: string, imageDataUrls?: string[], files?: { name: string; content: string }[], audioDataUrls?: string[]): Promise<void>
    retryFromMessage(messageId: string): Promise<void>
    editMessage(messageId: string, newContent: string): Promise<void>
    cancelStream(): void
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
        freeChatMemorySpaceIds: Ref<string[]>
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
        const msgId = createMessageId()

        messages.value.push({
            id: msgId,
            role: 'user',
            content,
            imageDataUrls,
            audioDataUrls,
            fileAttachments: files?.map(f => ({ name: f.name })),
            createdAt: Date.now()
        })

        agentStore.clearExecutionState()
        agentStore.setConversationExecutionState(conversationId, true)

        streaming.streamingContent.value = ''
        streaming.streamingThinking.value = ''
        streaming.isStreaming.value = true

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

        const tools = agentConfig.selectedToolNames.value
        const baseSystemPrompt = activeAgent?.systemPrompt || undefined
        const executionRun = {
            model: agentConfig.sessionModelOverride.value || undefined,
            providerOverride: agentConfig.sessionProviderOverride.value || undefined,
            systemPrompt: agentConfig.sessionSystemPrompt.value || baseSystemPrompt,
            subAgents: buildSubAgentAssignments(activeAgentId.value, [...agentConfig.freeChatSubAgentIds.value]),
            memorySpaceIds: agentConfig.freeChatMemorySelectionInitialized.value ? [...agentConfig.freeChatMemorySpaceIds.value] : undefined,
            thinkingEnabled: agentConfig.sessionThinkingEnabled.value,
            reasoningEffort: agentConfig.sessionReasoningEffort.value,
            autoToolRouting: agentConfig.sessionAutoToolRouting.value,
            autoMemory: agentConfig.sessionAutoMemory.value,
        }

        const prefs = usePreferencesStore()

        const request: ChatSendRequest = {
            content,
            messageId: msgId,
            imageDataUrls,
            audioDataUrls,
            files,
            run: {
                model: executionRun.model,
                providerOverride: executionRun.providerOverride,
                allowedTools: tools,
                systemPrompt: executionRun.systemPrompt,
                generateTitle: prefs.generateTitle,
                subAgents: executionRun.subAgents,
                memorySpaceIds: executionRun.memorySpaceIds,
                thinkingEnabled: executionRun.thinkingEnabled,
                reasoningEffort: executionRun.reasoningEffort,
                contextStrategy: prefs.contextStrategy,
                titleProviderId: prefs.titleProviderId || undefined,
                titleModel: prefs.titleModel || undefined,
                autoToolRouting: executionRun.autoToolRouting,
                autoMemory: executionRun.autoMemory,
                autoRouterProviderId: activeAgent?.autoRouterProviderId || prefs.autoRouterProviderId || undefined,
                autoRouterModel: activeAgent?.autoRouterModel || prefs.autoRouterModel || undefined,
                compactProviderId: prefs.compactProviderId || undefined,
                compactModel: prefs.compactModel || undefined,
                inlineAttachmentTextLimit: prefs.inlineAttachmentTextLimit,
                debugMode: prefs.debugMode,
            },
        }

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
        await api.chat.truncateFrom(conversationId, messageId)
        messages.value.splice(idx)
        streaming.clearConversationStreamState(conversationId)
        agentStore.truncateConversationExecution(conversationId, msg.createdAt)
        await sendMessage(msg.content, msg.imageDataUrls, undefined, msg.audioDataUrls)
    }

    async function editMessage(messageId: string, newContent: string): Promise<void> {
        if (!activeConversationId.value || activeConversationIsRunning()) return
        const conversationId = activeConversationId.value
        const idx = messages.value.findIndex(m => m.id === messageId)
        if (idx === -1) return
        const msg = messages.value[idx]
        if (msg.role !== 'user') return
        await api.chat.truncateFrom(conversationId, messageId)
        messages.value.splice(idx)
        streaming.clearConversationStreamState(conversationId)
        agentStore.truncateConversationExecution(conversationId, msg.createdAt)
        await sendMessage(newContent, msg.imageDataUrls, undefined, msg.audioDataUrls)
    }

    function cancelStream(): void {
        const id = streaming.primaryStreamId.value || streaming.currentStreamId.value
        const convId = activeConversationId.value
        if (id || convId) {
            api.chat.cancelStream(id || '', convId || undefined)
        }

        if (convId) {
            streaming.clearConversationStreamState(convId)
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
        if (convId) {
            agentStore.setConversationExecutionState(convId, false)
            agentStore.dismissHITLByConversation(convId)
        }

        if (convId) {
            cancelPostActions()
        }
    }

    function cancelPostActions(convId?: string): void {
        const id = convId || activeConversationId.value
        if (!id) return
        api.chat.cancelPostActions(id).catch(() => { })
    }

    return {
        sendMessage,
        retryFromMessage,
        editMessage,
        cancelStream,
        cancelPostActions,
    }
}
