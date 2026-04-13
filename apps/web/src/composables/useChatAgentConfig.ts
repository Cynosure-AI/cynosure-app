import { ref, computed, type Ref, type ComputedRef } from 'vue'
import { api } from '../api/client'
import { useAgentStore } from '../stores/agent.store'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import type { Conversation, DisplayMessage } from '../stores/chat.store'

export interface ChatAgentConfigApi {
    activeAgentId: Ref<string | null>
    sessionModelOverride: Ref<string | null>
    sessionProviderOverride: Ref<string | null>
    sessionOverrideSubAgents: Ref<boolean>
    freeChatSubAgentIds: Ref<string[]>
    freeChatMemorySpaceIds: Ref<string[]>
    agentOriginalTools: Ref<string[]>
    agentOriginalSubAgentIds: Ref<string[]>
    agentOriginalMemorySpaceIds: Ref<string[]>
    hasAgentOverrides: ComputedRef<boolean>
    markOverridesModified(): void
    resetAgentOverrides(): void
    applyOverridesToAgent(): Promise<void>
    setActiveAgent(id: string | null): Promise<void>
    setSessionModel(model: string | null, providerId?: string | null): void
    syncAgentBaseline(): void
}

export function useChatAgentConfig(
    activeConversationId: Ref<string | null>,
    messages: Ref<DisplayMessage[]>,
    conversations: Ref<Conversation[]>,
    loadConversations: () => Promise<void>,
): ChatAgentConfigApi {
    const agentStore = useAgentStore()

    const activeAgentId = ref<string | null>(
        localStorage.getItem('oa-active-agent') || null
    )
    const sessionModelOverride = ref<string | null>(null)
    const sessionProviderOverride = ref<string | null>(null)
    const sessionOverrideSubAgents = ref<boolean>(true)
    const freeChatSubAgentIds = ref<string[]>([])
    const freeChatMemorySpaceIds = ref<string[]>([])
    const agentOriginalTools = ref<string[]>([])
    const agentOriginalSubAgentIds = ref<string[]>([])
    const agentOriginalMemorySpaceIds = ref<string[]>([])
    const userModifiedOverrides = ref(false)

    function arraysEqual(a: string[], b: string[]): boolean {
        if (a.length !== b.length) return false
        const sorted1 = [...a].sort()
        const sorted2 = [...b].sort()
        return sorted1.every((v, i) => v === sorted2[i])
    }

    const hasAgentOverrides = computed(() => {
        if (!activeAgentId.value || !userModifiedOverrides.value) return false
        return (
            !arraysEqual(agentStore.selectedToolNames, agentOriginalTools.value) ||
            !arraysEqual(freeChatSubAgentIds.value, agentOriginalSubAgentIds.value) ||
            !arraysEqual(freeChatMemorySpaceIds.value, agentOriginalMemorySpaceIds.value)
        )
    })

    function markOverridesModified(): void {
        userModifiedOverrides.value = true
    }

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
                    ? def.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + '_agent'
                    : id
                return { agentId: id, codename, role: def?.description || '' }
            })
        }
        if (!arraysEqual(freeChatMemorySpaceIds.value, agentOriginalMemorySpaceIds.value)) {
            updates.memorySpaces = [...freeChatMemorySpaceIds.value]
        }

        if (Object.keys(updates).length === 0) return
        await agentDefs.update(activeAgentId.value, updates)

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
            const tools = agent?.tools?.length ? [...agent.tools] : []
            agentStore.selectedToolNames = tools
            agentOriginalTools.value = [...tools]
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
        sessionModelOverride.value = null
        sessionProviderOverride.value = null
        activeConversationId.value = null
        messages.value = []
        await loadConversations()
    }

    function setSessionModel(model: string | null, providerId?: string | null): void {
        sessionModelOverride.value = model || null
        sessionProviderOverride.value = (model ? providerId : null) || null
    }

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

    return {
        activeAgentId,
        sessionModelOverride,
        sessionProviderOverride,
        sessionOverrideSubAgents,
        freeChatSubAgentIds,
        freeChatMemorySpaceIds,
        agentOriginalTools,
        agentOriginalSubAgentIds,
        agentOriginalMemorySpaceIds,
        hasAgentOverrides,
        markOverridesModified,
        resetAgentOverrides,
        applyOverridesToAgent,
        setActiveAgent,
        setSessionModel,
        syncAgentBaseline,
    }
}
