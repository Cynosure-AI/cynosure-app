import { type Ref } from 'vue'
import { api } from '../api/client'
import { useAgentStore } from '../stores/agent.store'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { useProviderStore } from '../stores/provider.store'
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
        freeChatSubAgentIds: Ref<string[]>
        freeChatMemorySpaceIds: Ref<string[]>
        agentOriginalSubAgentIds: Ref<string[]>
        agentOriginalMemorySpaceIds: Ref<string[]>
    },
): ChatMessagesApi {
    const agentStore = useAgentStore()
    const providerStore = useProviderStore()

    function arraysEqual(a: string[], b: string[]): boolean {
        if (a.length !== b.length) return false
        const sorted1 = [...a].sort()
        const sorted2 = [...b].sort()
        return sorted1.every((v, i) => v === sorted2[i])
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
        const msgId = crypto.randomUUID()

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

        const agent = activeAgentId.value ? agentDefs.get(activeAgentId.value) : null
        const tools = agentStore.selectedToolNames

        let model = agentConfig.sessionModelOverride.value || undefined
        const providerOverride = agentConfig.sessionProviderOverride.value || undefined
        if (!model && providerOverride) {
            const provider = providerStore.providers.find(p => p.id === providerOverride)
            model = provider?.defaultModel || undefined
        }
        const systemPrompt = agent?.systemPrompt || undefined

        const { usePreferencesStore } = await import('../stores/preferences.store')
        const prefs = usePreferencesStore()

        const hasSubAgentOverride = agent && !arraysEqual(agentConfig.freeChatSubAgentIds.value, agentConfig.agentOriginalSubAgentIds.value)
        const hasMemSpaceOverride = agent && !arraysEqual(agentConfig.freeChatMemorySpaceIds.value, agentConfig.agentOriginalMemorySpaceIds.value)
        const subAgents = hasSubAgentOverride
            ? agentConfig.freeChatSubAgentIds.value.map(id => {
                const def = agentDefs.get(id)
                const codename = def ? def.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : id
                return { agentId: id, codename, role: def?.description || '' }
            })
            : (!agent && agentConfig.freeChatSubAgentIds.value.length)
                ? agentConfig.freeChatSubAgentIds.value.map(id => {
                    const def = agentDefs.get(id)
                    const codename = def ? def.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : id
                    return { agentId: id, codename, role: def?.description || '' }
                })
                : undefined
        const memorySpaceIds = hasMemSpaceOverride
            ? agentConfig.freeChatMemorySpaceIds.value
            : (!agent && agentConfig.freeChatMemorySpaceIds.value.length)
                ? agentConfig.freeChatMemorySpaceIds.value
                : undefined

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
            memorySpaceIds,
            agentConfig.sessionOverrideSubAgents.value
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
