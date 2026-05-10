import { type Ref } from 'vue'
import { api } from '../api/client'
import { useAgentStore } from '../stores/agent-runtime.store'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
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
        freeChatSubAgentIds: Ref<string[]>
        freeChatMemorySpaceIds: Ref<string[]>
    },
): ChatMessagesApi {
    const agentStore = useAgentStore()

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
        const msgId = typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : ([1e7] as any + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c: number) =>
                (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
            )

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
            memorySpaceIds: [...agentConfig.freeChatMemorySpaceIds.value],
            overrideSubAgents: agentConfig.sessionOverrideSubAgents.value,
            thinkingEnabled: agentConfig.sessionThinkingEnabled.value,
            autoToolRouting: agentConfig.sessionAutoToolRouting.value,
        }

        const { usePreferencesStore } = await import('../stores/preferences.store')
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
            prefs.toolRouterProviderId || undefined,
            prefs.toolRouterModel || undefined
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
        agentStore.clearExecutionState()

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
