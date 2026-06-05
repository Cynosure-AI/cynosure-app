import { ref, computed, type Ref, type ComputedRef } from 'vue'
import { useAgentStore } from '../stores/agent-runtime.store'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import type { Conversation, DisplayMessage } from '../stores/chat.store'
import { SK_ACTIVE_AGENT } from '../utils/storage-keys'

export interface ChatAgentConfigApi {
    activeAgentId: Ref<string | null>
    sessionModelOverride: Ref<string | null>
    sessionProviderOverride: Ref<string | null>
    sessionOverrideSubAgents: Ref<boolean>
    sessionSystemPrompt: Ref<string>
    sessionThinkingEnabled: Ref<boolean>
    sessionAutoToolRouting: Ref<boolean>
    sessionAutoMemory: Ref<boolean>
    sessionAutoSkillRouting: Ref<boolean>
    agentOriginalSystemPrompt: Ref<string>
    freeChatSubAgentIds: Ref<string[]>
    freeChatMemorySpaceIds: Ref<string[]>
    freeChatSkillIds: Ref<string[]>
    agentOriginalTools: Ref<string[]>
    agentOriginalSubAgentIds: Ref<string[]>
    agentOriginalMemorySpaceIds: Ref<string[]>
    freeChatMemorySelectionInitialized: Ref<boolean>
    agentOriginalSkillIds: Ref<string[]>
    hasAgentOverrides: ComputedRef<boolean>
    markOverridesModified(): void
    resetAgentOverrides(): void
    resetToDefaults(): void
    applyOverridesToAgent(): Promise<void>
    setActiveAgent(id: string | null): Promise<void>
    setConversationAgent(id: string | null): void
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
        localStorage.getItem(SK_ACTIVE_AGENT) || null
    )
    const sessionModelOverride = ref<string | null>(null)
    const sessionProviderOverride = ref<string | null>(null)
    const sessionOverrideSubAgents = ref<boolean>(false)
    const sessionSystemPrompt = ref<string>('')
    const sessionThinkingEnabled = ref<boolean>(true)
    const sessionAutoToolRouting = ref<boolean>(!activeAgentId.value)
    const sessionAutoMemory = ref<boolean>(true)
    const sessionAutoSkillRouting = ref<boolean>(true)
    const agentOriginalOverrideSubAgents = ref<boolean>(false)
    const agentOriginalAutoToolRouting = ref<boolean>(false)
    const agentOriginalAutoMemory = ref<boolean>(true)
    const agentOriginalAutoSkillRouting = ref<boolean>(true)
    const agentOriginalThinkingEnabled = ref<boolean>(true)
    const agentOriginalSystemPrompt = ref<string>('')
    const agentOriginalModel = ref<string | null>(null)
    const agentOriginalProviderId = ref<string | null>(null)
    const freeChatSubAgentIds = ref<string[]>([])
    const freeChatMemorySpaceIds = ref<string[]>([])
    const freeChatMemorySelectionInitialized = ref<boolean>(false)
    const freeChatSkillIds = ref<string[]>([])
    const agentOriginalTools = ref<string[]>([])
    const agentOriginalSubAgentIds = ref<string[]>([])
    const agentOriginalMemorySpaceIds = ref<string[]>([])
    const agentOriginalSkillIds = ref<string[]>([])
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
            !arraysEqual(freeChatMemorySpaceIds.value, agentOriginalMemorySpaceIds.value) ||
            !arraysEqual(freeChatSkillIds.value, agentOriginalSkillIds.value) ||
            sessionSystemPrompt.value !== agentOriginalSystemPrompt.value ||
            sessionThinkingEnabled.value !== agentOriginalThinkingEnabled.value ||
            sessionOverrideSubAgents.value !== agentOriginalOverrideSubAgents.value ||
            sessionAutoToolRouting.value !== agentOriginalAutoToolRouting.value ||
            sessionAutoMemory.value !== agentOriginalAutoMemory.value ||
            sessionAutoSkillRouting.value !== agentOriginalAutoSkillRouting.value ||
            sessionProviderOverride.value !== null ||
            (sessionModelOverride.value !== null && sessionModelOverride.value !== agentOriginalModel.value)
        )
    })

    function markOverridesModified(): void {
        userModifiedOverrides.value = true
    }

    function resetAgentOverrides(): void {
        agentStore.selectedToolNames = [...agentOriginalTools.value]
        freeChatSubAgentIds.value = [...agentOriginalSubAgentIds.value]
        freeChatMemorySpaceIds.value = [...agentOriginalMemorySpaceIds.value]
        freeChatMemorySelectionInitialized.value = true
        freeChatSkillIds.value = [...agentOriginalSkillIds.value]
        sessionSystemPrompt.value = agentOriginalSystemPrompt.value
        sessionThinkingEnabled.value = agentOriginalThinkingEnabled.value
        sessionOverrideSubAgents.value = agentOriginalOverrideSubAgents.value
        sessionAutoToolRouting.value = agentOriginalAutoToolRouting.value
        sessionAutoMemory.value = agentOriginalAutoMemory.value
        sessionAutoSkillRouting.value = agentOriginalAutoSkillRouting.value
        sessionModelOverride.value = null
        sessionProviderOverride.value = null
        userModifiedOverrides.value = false
    }

    function resetToDefaults(): void {
        agentStore.clearSelectedTools()
        freeChatSubAgentIds.value = []
        const defaultMemorySpaceIds = activeAgentId.value ? [] : [...agentOriginalMemorySpaceIds.value]
        freeChatMemorySpaceIds.value = [...defaultMemorySpaceIds]
        freeChatMemorySelectionInitialized.value = defaultMemorySpaceIds.length > 0
        freeChatSkillIds.value = []
        sessionSystemPrompt.value = ''
        sessionThinkingEnabled.value = true
        sessionOverrideSubAgents.value = false
        sessionAutoToolRouting.value = true
        sessionAutoMemory.value = true
        sessionAutoSkillRouting.value = true
        sessionModelOverride.value = null
        sessionProviderOverride.value = null
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
            const existingAgent = agentDefs.get(activeAgentId.value!)
            updates.subAgents = freeChatSubAgentIds.value.map(id => {
                const def = agentDefs.get(id)
                // Preserve the custom codename for existing assignments; auto-generate for new ones.
                const existing = existingAgent?.subAgents?.find(s => s.agentId === id)
                const codename = existing?.codename
                    || (def ? def.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + '_agent' : id)
                return { agentId: id, codename, role: existing?.role || def?.description || '' }
            })
        }
        if (!arraysEqual(freeChatMemorySpaceIds.value, agentOriginalMemorySpaceIds.value)) {
            updates.memorySpaces = [...freeChatMemorySpaceIds.value]
        }
        if (!arraysEqual(freeChatSkillIds.value, agentOriginalSkillIds.value)) {
            updates.skills = [...freeChatSkillIds.value]
        }

        if (sessionSystemPrompt.value !== agentOriginalSystemPrompt.value) {
            updates.systemPrompt = sessionSystemPrompt.value
        }

        if (sessionThinkingEnabled.value !== agentOriginalThinkingEnabled.value) {
            updates.thinkingEnabled = sessionThinkingEnabled.value
        }

        if (sessionOverrideSubAgents.value !== agentOriginalOverrideSubAgents.value) {
            updates.overrideSubAgents = sessionOverrideSubAgents.value
        }

        if (sessionAutoToolRouting.value !== agentOriginalAutoToolRouting.value) {
            updates.autoToolRouting = sessionAutoToolRouting.value
        }

        if (sessionAutoMemory.value !== agentOriginalAutoMemory.value) {
            updates.autoMemory = sessionAutoMemory.value
        }

        if (sessionAutoSkillRouting.value !== agentOriginalAutoSkillRouting.value) {
            updates.autoSkillRouting = sessionAutoSkillRouting.value
        }

        if (sessionProviderOverride.value !== null) {
            // Provider changed: save new provider and resolve model
            // If no explicit model override, clear the model to avoid a mismatch
            // (old provider's model is incompatible with the new provider)
            updates.providerId = sessionProviderOverride.value
            updates.model = sessionModelOverride.value ?? null
        } else if (sessionModelOverride.value !== null && sessionModelOverride.value !== agentOriginalModel.value) {
            updates.model = sessionModelOverride.value
        }

        if (Object.keys(updates).length === 0) return
        await agentDefs.update(activeAgentId.value, updates)

        agentOriginalTools.value = [...agentStore.selectedToolNames]
        agentOriginalSubAgentIds.value = [...freeChatSubAgentIds.value]
        agentOriginalMemorySpaceIds.value = [...freeChatMemorySpaceIds.value]
        agentOriginalSkillIds.value = [...freeChatSkillIds.value]
        agentOriginalSystemPrompt.value = sessionSystemPrompt.value
        agentOriginalThinkingEnabled.value = sessionThinkingEnabled.value
        agentOriginalOverrideSubAgents.value = sessionOverrideSubAgents.value
        agentOriginalAutoToolRouting.value = sessionAutoToolRouting.value
        agentOriginalAutoMemory.value = sessionAutoMemory.value
        agentOriginalAutoSkillRouting.value = sessionAutoSkillRouting.value
        if (updates.providerId !== undefined) agentOriginalProviderId.value = updates.providerId as string
        if ('model' in updates) agentOriginalModel.value = (updates.model as string | null)
        sessionModelOverride.value = null
        sessionProviderOverride.value = null
        userModifiedOverrides.value = false
    }

    function applyAgentSelection(id: string | null): void {
        activeAgentId.value = id
        userModifiedOverrides.value = false
        if (id) {
            localStorage.setItem(SK_ACTIVE_AGENT, id)
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
            freeChatMemorySelectionInitialized.value = true
            const skillIds = agent?.skills?.length ? [...agent.skills] : []
            freeChatSkillIds.value = [...skillIds]
            agentOriginalSkillIds.value = [...skillIds]
            sessionSystemPrompt.value = agent?.systemPrompt || ''
            agentOriginalSystemPrompt.value = agent?.systemPrompt || ''
            agentOriginalModel.value = agent?.model || null
            agentOriginalProviderId.value = agent?.providerId || null
            sessionThinkingEnabled.value = agent?.thinkingEnabled !== false
            agentOriginalThinkingEnabled.value = sessionThinkingEnabled.value
            sessionOverrideSubAgents.value = agent?.overrideSubAgents === true
            agentOriginalOverrideSubAgents.value = sessionOverrideSubAgents.value
            sessionAutoToolRouting.value = agent?.autoToolRouting === true
            agentOriginalAutoToolRouting.value = sessionAutoToolRouting.value
            sessionAutoMemory.value = agent?.autoMemory === true
            agentOriginalAutoMemory.value = sessionAutoMemory.value
            sessionAutoSkillRouting.value = agent?.autoSkillRouting !== false
            agentOriginalAutoSkillRouting.value = sessionAutoSkillRouting.value
        } else {
            localStorage.removeItem(SK_ACTIVE_AGENT)
            agentStore.clearSelectedTools()
            freeChatSubAgentIds.value = []
            freeChatMemorySpaceIds.value = []
            freeChatMemorySelectionInitialized.value = false
            freeChatSkillIds.value = []
            agentOriginalTools.value = []
            agentOriginalSubAgentIds.value = []
            agentOriginalMemorySpaceIds.value = []
            agentOriginalSkillIds.value = []
            sessionSystemPrompt.value = ''
            agentOriginalSystemPrompt.value = ''
            sessionThinkingEnabled.value = true
            agentOriginalThinkingEnabled.value = true
            sessionOverrideSubAgents.value = false
            agentOriginalOverrideSubAgents.value = false
            agentOriginalAutoToolRouting.value = true
            sessionAutoToolRouting.value = true
            agentOriginalAutoMemory.value = true
            sessionAutoMemory.value = true
            agentOriginalAutoSkillRouting.value = true
            sessionAutoSkillRouting.value = true
            agentOriginalModel.value = null
            agentOriginalProviderId.value = null
        }
        sessionModelOverride.value = null
        sessionProviderOverride.value = null
    }

    async function setActiveAgent(id: string | null) {
        applyAgentSelection(id)
        activeConversationId.value = null
        messages.value = []
        await loadConversations()
    }

    function setConversationAgent(id: string | null): void {
        applyAgentSelection(id)
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
        freeChatMemorySelectionInitialized.value = true
        const skillIds = agent.skills?.length ? [...agent.skills] : []
        freeChatSkillIds.value = [...skillIds]
        agentOriginalSkillIds.value = [...skillIds]
        sessionSystemPrompt.value = agent.systemPrompt || ''
        agentOriginalSystemPrompt.value = agent.systemPrompt || ''
        agentOriginalModel.value = agent.model || null
        agentOriginalProviderId.value = agent.providerId || null
        const thinking = agent.thinkingEnabled !== false
        sessionThinkingEnabled.value = thinking
        agentOriginalThinkingEnabled.value = thinking
        const overrideSubs = agent.overrideSubAgents === true
        sessionOverrideSubAgents.value = overrideSubs
        agentOriginalOverrideSubAgents.value = overrideSubs
        const autoRouting = agent.autoToolRouting === true
        sessionAutoToolRouting.value = autoRouting
        agentOriginalAutoToolRouting.value = autoRouting
        sessionAutoMemory.value = agent.autoMemory === true
        agentOriginalAutoMemory.value = sessionAutoMemory.value
        sessionAutoSkillRouting.value = agent.autoSkillRouting !== false
        agentOriginalAutoSkillRouting.value = sessionAutoSkillRouting.value
        sessionModelOverride.value = null
        sessionProviderOverride.value = null
        userModifiedOverrides.value = false
    }

    return {
        activeAgentId,
        sessionModelOverride,
        sessionProviderOverride,
        sessionOverrideSubAgents,
        sessionSystemPrompt,
        sessionThinkingEnabled,
        sessionAutoToolRouting,
        sessionAutoMemory,
        sessionAutoSkillRouting,
        agentOriginalSystemPrompt,
        freeChatSubAgentIds,
        freeChatMemorySpaceIds,
        freeChatMemorySelectionInitialized,
        freeChatSkillIds,
        agentOriginalTools,
        agentOriginalSubAgentIds,
        agentOriginalMemorySpaceIds,
        agentOriginalSkillIds,
        hasAgentOverrides,
        markOverridesModified,
        resetAgentOverrides,
        resetToDefaults,
        applyOverridesToAgent,
        setActiveAgent,
        setConversationAgent,
        setSessionModel,
        syncAgentBaseline,
    }
}
