import { type Ref } from 'vue'
import { api } from '../api/client'
import { useAgentStore } from '../stores/agent-runtime.store'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { usePreferencesStore } from '../stores/preferences.store'
import type { SubAgentAssignment } from '../api/types'
import type { DisplayMessage } from '../stores/chat.store'
import type { ChatStreamingState } from './useChatStreaming'

export interface ChatMessagesApi {
    sendMessage(content: string, imageDataUrls?: string[], files?: { name: string; content: string }[], audioDataUrls?: string[]): Promise<void>
    retryFromMessage(messageId: string): Promise<void>
    editMessage(messageId: string, newContent: string): Promise<void>
    cancelStream(): void
    cancelPostActions(): void
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
        sessionOverrideSubAgents: Ref<boolean>
        sessionSystemPrompt: Ref<string>
        sessionThinkingEnabled: Ref<boolean>
        sessionAutoToolRouting: Ref<boolean>
        sessionAutoMemory: Ref<boolean>
        sessionAutoSkillRouting: Ref<boolean>
        freeChatSubAgentIds: Ref<string[]>
        freeChatMemorySpaceIds: Ref<string[]>
        freeChatMemorySelectionInitialized: Ref<boolean>
        freeChatSkillIds: Ref<string[]>
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

    function toSubAgentCodename(name: string): string {
        return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + '_agent'
    }

    function buildSubAgentAssignments(parentAgentId: string | null, selectedIds: string[]): SubAgentAssignment[] {
        const agentDefs = useAgentDefinitionsStore()
        const parentAgent = parentAgentId ? agentDefs.get(parentAgentId) : null

        return selectedIds.map((id) => {
            const def = agentDefs.get(id)
            const assignment = parentAgent?.subAgents?.find((subAgent) => subAgent.agentId === id)
            const codename = assignment?.codename || (def ? toSubAgentCodename(def.name) : id)

            return {
                agentId: id,
                codename,
                role: assignment?.role || def?.description || '',
            }
        })
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

        const tools = agentStore.selectedToolNames
        const baseSystemPrompt = activeAgent?.systemPrompt || undefined
        const executionRun = {
            model: agentConfig.sessionModelOverride.value || undefined,
            providerOverride: agentConfig.sessionProviderOverride.value || undefined,
            systemPrompt: agentConfig.sessionSystemPrompt.value || baseSystemPrompt,
            subAgents: buildSubAgentAssignments(activeAgentId.value, [...agentConfig.freeChatSubAgentIds.value]),
            memorySpaceIds: agentConfig.freeChatMemorySelectionInitialized.value ? [...agentConfig.freeChatMemorySpaceIds.value] : undefined,
            selectedSkillIds: [...agentConfig.freeChatSkillIds.value],
            overrideSubAgents: agentConfig.sessionOverrideSubAgents.value,
            thinkingEnabled: agentConfig.sessionThinkingEnabled.value,
            autoToolRouting: agentConfig.sessionAutoToolRouting.value,
            autoMemory: agentConfig.sessionAutoMemory.value,
            autoSkillRouting: agentConfig.sessionAutoSkillRouting.value,
        }

        const prefs = usePreferencesStore()

        await api.chat.send(
            conversationId,
            content,
            executionRun.model,
            executionRun.providerOverride,
            imageDataUrls,
            tools,
            files,
            executionRun.systemPrompt,
            prefs.generateTitle,
            msgId,
            audioDataUrls,
            executionRun.subAgents,
            executionRun.memorySpaceIds,
            executionRun.overrideSubAgents,
            executionRun.thinkingEnabled,
            prefs.contextStrategy,
            prefs.titleProviderId || undefined,
            prefs.titleModel || undefined,
            executionRun.autoToolRouting,
            executionRun.selectedSkillIds,
            executionRun.autoSkillRouting,
            prefs.toolRouterProviderId || undefined,
            prefs.toolRouterModel || undefined,
            executionRun.autoMemory,
            activeAgent?.memoryRouterProviderId || prefs.memoryRouterProviderId || undefined,
            activeAgent?.memoryRouterModel || prefs.memoryRouterModel || undefined,
            activeAgent?.skillRouterProviderId || prefs.skillRouterProviderId || undefined,
            activeAgent?.skillRouterModel || prefs.skillRouterModel || undefined,
            prefs.compactProviderId || undefined,
            prefs.compactModel || undefined
        )
    }

    async function retryFromMessage(messageId: string): Promise<void> {
        if (!activeConversationId.value || streaming.isStreaming.value) return
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
        if (!activeConversationId.value || streaming.isStreaming.value) return
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
        const id = streaming.primaryStreamId.value || streaming.currentStreamId.value
        const convId = activeConversationId.value
        if (id || convId) {
            api.chat.cancelStream(id || '', convId || undefined)
        }

        streaming.isStreaming.value = false
        streaming.currentStreamId.value = null
        streaming.primaryStreamId.value = null
        streaming.primaryStreamAgent.value = {}
        const streamMsg = streaming.findStreamingMsg()
        if (streamMsg) {
            streamMsg.isStreaming = false
            if (!streamMsg.content && !streamMsg.thinking) {
                messages.value.pop()
            }
        }
        streaming.streamingContent.value = ''
        streaming.streamingThinking.value = ''
        if (convId) {
            streaming.streamBuffers.delete(convId)
        }
        if (convId) {
            agentStore.setConversationExecutionState(convId, false)
        }

        if (convId) {
            cancelPostActions()
        }
    }

    function cancelPostActions(): void {
        const convId = activeConversationId.value
        if (!convId) return
        api.chat.cancelPostActions(convId).catch(() => { })
    }

    return {
        sendMessage,
        retryFromMessage,
        editMessage,
        cancelStream,
        cancelPostActions,
    }
}
