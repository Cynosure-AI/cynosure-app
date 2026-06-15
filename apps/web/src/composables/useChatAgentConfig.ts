import { ref, computed, type Ref, type ComputedRef } from 'vue'
import { useAgentStore } from '../stores/agent-runtime.store'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import type { Conversation, DisplayMessage } from '../stores/chat.store'
import { SK_ACTIVE_AGENT } from '../utils/storage-keys'

interface ChatPreset {
    tools: string[]
    subAgentIds: string[]
    memorySpaceIds: string[]
    skillIds: string[]
    systemPrompt: string
    thinkingEnabled: boolean
    autoToolRouting: boolean
    autoMemory: boolean
    autoSkillRouting: boolean
    modelOverride: string | null
    providerOverride: string | null
}

export interface ChatAgentConfigApi {
    activeAgentId: Ref<string | null>
    sessionModelOverride: Ref<string | null>
    sessionProviderOverride: Ref<string | null>
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
    hasFreeChatOverrides: ComputedRef<boolean>
    markOverridesModified(): void
    resetAgentOverrides(): void
    resetToDefaults(): void
    applyOverridesToAgent(): Promise<void>
    setActiveAgent(id: string | null): Promise<void>
    setConversationAgent(id: string | null): void
    setSessionModel(model: string | null, providerId?: string | null): void
    syncAgentBaseline(): void
    setFreeChatDefaultMemorySpaceIds(ids: string[]): void
    ensureFreeChatPreset(): void
    captureFreeChatPreset(): void
}

function arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false
    const sorted1 = [...a].sort()
    const sorted2 = [...b].sort()
    return sorted1.every((v, i) => v === sorted2[i])
}

function clonePreset(preset: ChatPreset): ChatPreset {
    return {
        ...preset,
        tools: [...preset.tools],
        subAgentIds: [...preset.subAgentIds],
        memorySpaceIds: [...preset.memorySpaceIds],
        skillIds: [...preset.skillIds],
    }
}

function presetsEqual(a: ChatPreset, b: ChatPreset): boolean {
    return arraysEqual(a.tools, b.tools) &&
        arraysEqual(a.subAgentIds, b.subAgentIds) &&
        arraysEqual(a.memorySpaceIds, b.memorySpaceIds) &&
        arraysEqual(a.skillIds, b.skillIds) &&
        a.systemPrompt === b.systemPrompt &&
        a.thinkingEnabled === b.thinkingEnabled &&
        a.autoToolRouting === b.autoToolRouting &&
        a.autoMemory === b.autoMemory &&
        a.autoSkillRouting === b.autoSkillRouting &&
        a.modelOverride === b.modelOverride &&
        a.providerOverride === b.providerOverride
}

export function useChatAgentConfig(
    activeConversationId: Ref<string | null>,
    messages: Ref<DisplayMessage[]>,
    conversations: Ref<Conversation[]>,
    loadConversations: () => Promise<void>,
): ChatAgentConfigApi {
    const agentStore = useAgentStore()

    const activeAgentId = ref<string | null>(
        sessionStorage.getItem(SK_ACTIVE_AGENT) || null
    )
    const sessionModelOverride = ref<string | null>(null)
    const sessionProviderOverride = ref<string | null>(null)
    const sessionSystemPrompt = ref<string>('')
    const sessionThinkingEnabled = ref<boolean>(true)
    const sessionAutoToolRouting = ref<boolean>(!activeAgentId.value)
    const sessionAutoMemory = ref<boolean>(true)
    const sessionAutoSkillRouting = ref<boolean>(true)
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
    const freeChatDefaultMemorySpaceIds = ref<string[]>([])
    const freeChatPreset = ref<ChatPreset | null>(null)

    function regularFreeChatPreset(): ChatPreset {
        return {
            tools: [],
            subAgentIds: [],
            memorySpaceIds: [...freeChatDefaultMemorySpaceIds.value],
            skillIds: [],
            systemPrompt: '',
            thinkingEnabled: true,
            autoToolRouting: true,
            autoMemory: true,
            autoSkillRouting: true,
            modelOverride: null,
            providerOverride: null,
        }
    }

    function currentPreset(): ChatPreset {
        return {
            tools: [...agentStore.selectedToolNames],
            subAgentIds: [...freeChatSubAgentIds.value],
            memorySpaceIds: [...freeChatMemorySpaceIds.value],
            skillIds: [...freeChatSkillIds.value],
            systemPrompt: sessionSystemPrompt.value,
            thinkingEnabled: sessionThinkingEnabled.value,
            autoToolRouting: sessionAutoToolRouting.value,
            autoMemory: sessionAutoMemory.value,
            autoSkillRouting: sessionAutoSkillRouting.value,
            modelOverride: sessionModelOverride.value,
            providerOverride: sessionProviderOverride.value,
        }
    }

    function applyPreset(preset: ChatPreset): void {
        agentStore.selectedToolNames = [...preset.tools]
        freeChatSubAgentIds.value = [...preset.subAgentIds]
        freeChatMemorySpaceIds.value = [...preset.memorySpaceIds]
        freeChatMemorySelectionInitialized.value = true
        freeChatSkillIds.value = [...preset.skillIds]
        sessionSystemPrompt.value = preset.systemPrompt
        sessionThinkingEnabled.value = preset.thinkingEnabled
        sessionAutoToolRouting.value = preset.autoToolRouting
        sessionAutoMemory.value = preset.autoMemory
        sessionAutoSkillRouting.value = preset.autoSkillRouting
        sessionModelOverride.value = preset.modelOverride
        sessionProviderOverride.value = preset.providerOverride
    }

    function setAgentBaseline(preset: ChatPreset, model: string | null, providerId: string | null): void {
        agentOriginalTools.value = [...preset.tools]
        agentOriginalSubAgentIds.value = [...preset.subAgentIds]
        agentOriginalMemorySpaceIds.value = [...preset.memorySpaceIds]
        agentOriginalSkillIds.value = [...preset.skillIds]
        agentOriginalSystemPrompt.value = preset.systemPrompt
        agentOriginalThinkingEnabled.value = preset.thinkingEnabled
        agentOriginalAutoToolRouting.value = preset.autoToolRouting
        agentOriginalAutoMemory.value = preset.autoMemory
        agentOriginalAutoSkillRouting.value = preset.autoSkillRouting
        agentOriginalModel.value = model
        agentOriginalProviderId.value = providerId
    }

    function agentPreset(id: string): { preset: ChatPreset; model: string | null; providerId: string | null } {
        const agentDefs = useAgentDefinitionsStore()
        const agent = agentDefs.get(id)
        return {
            preset: {
                tools: agent?.tools?.length ? [...agent.tools] : [],
                subAgentIds: agent?.subAgents?.map(s => s.agentId) ?? [],
                memorySpaceIds: agent?.memorySpaces?.length ? [...agent.memorySpaces] : [],
                skillIds: agent?.skills?.length ? [...agent.skills] : [],
                systemPrompt: agent?.systemPrompt || '',
                thinkingEnabled: agent?.thinkingEnabled !== false,
                autoToolRouting: agent?.autoToolRouting === true,
                autoMemory: agent?.autoMemory === true,
                autoSkillRouting: agent?.autoSkillRouting !== false,
                modelOverride: null,
                providerOverride: null,
            },
            model: agent?.model || null,
            providerId: agent?.providerId || null,
        }
    }

    function ensureFreeChatPreset(): void {
        if (!freeChatPreset.value) {
            freeChatPreset.value = regularFreeChatPreset()
        }
        if (!activeAgentId.value && !freeChatMemorySelectionInitialized.value) {
            applyPreset(freeChatPreset.value)
        }
    }

    function captureFreeChatPreset(): void {
        if (activeAgentId.value) return
        freeChatPreset.value = currentPreset()
    }

    function setFreeChatDefaultMemorySpaceIds(ids: string[]): void {
        const nextIds = [...ids]
        const previousDefault = regularFreeChatPreset()
        freeChatDefaultMemorySpaceIds.value = nextIds
        const nextDefault = regularFreeChatPreset()
        if (!freeChatPreset.value || presetsEqual(freeChatPreset.value, previousDefault)) {
            freeChatPreset.value = clonePreset(nextDefault)
        }
        if (!activeAgentId.value && (!freeChatMemorySelectionInitialized.value || presetsEqual(currentPreset(), previousDefault))) {
            applyPreset(freeChatPreset.value)
        }
    }

    const hasAgentOverrides = computed(() => {
        if (!activeAgentId.value) return false
        return (
            !arraysEqual(agentStore.selectedToolNames, agentOriginalTools.value) ||
            !arraysEqual(freeChatSubAgentIds.value, agentOriginalSubAgentIds.value) ||
            !arraysEqual(freeChatMemorySpaceIds.value, agentOriginalMemorySpaceIds.value) ||
            !arraysEqual(freeChatSkillIds.value, agentOriginalSkillIds.value) ||
            sessionSystemPrompt.value !== agentOriginalSystemPrompt.value ||
            sessionThinkingEnabled.value !== agentOriginalThinkingEnabled.value ||
            sessionAutoToolRouting.value !== agentOriginalAutoToolRouting.value ||
            sessionAutoMemory.value !== agentOriginalAutoMemory.value ||
            sessionAutoSkillRouting.value !== agentOriginalAutoSkillRouting.value ||
            sessionProviderOverride.value !== null ||
            (sessionModelOverride.value !== null && sessionModelOverride.value !== agentOriginalModel.value)
        )
    })

    const hasFreeChatOverrides = computed(() => {
        if (activeAgentId.value) return false
        return !presetsEqual(currentPreset(), regularFreeChatPreset())
    })

    function markOverridesModified(): void {
        captureFreeChatPreset()
    }

    function resetAgentOverrides(): void {
        applyPreset({
            tools: [...agentOriginalTools.value],
            subAgentIds: [...agentOriginalSubAgentIds.value],
            memorySpaceIds: [...agentOriginalMemorySpaceIds.value],
            skillIds: [...agentOriginalSkillIds.value],
            systemPrompt: agentOriginalSystemPrompt.value,
            thinkingEnabled: agentOriginalThinkingEnabled.value,
            autoToolRouting: agentOriginalAutoToolRouting.value,
            autoMemory: agentOriginalAutoMemory.value,
            autoSkillRouting: agentOriginalAutoSkillRouting.value,
            modelOverride: null,
            providerOverride: null,
        })
    }

    function resetToDefaults(): void {
        if (activeAgentId.value) {
            resetAgentOverrides()
            return
        }
        const preset = regularFreeChatPreset()
        freeChatPreset.value = clonePreset(preset)
        applyPreset(preset)
    }

    async function applyOverridesToAgent(): Promise<void> {
        if (!activeAgentId.value) return
        const agentDefs = useAgentDefinitionsStore()
        const updates: Record<string, unknown> = {}

        if (!arraysEqual(agentStore.selectedToolNames, agentOriginalTools.value)) {
            updates.tools = [...agentStore.selectedToolNames]
        }
        if (!arraysEqual(freeChatSubAgentIds.value, agentOriginalSubAgentIds.value)) {
            const existingAgent = agentDefs.get(activeAgentId.value)
            updates.subAgents = freeChatSubAgentIds.value.map(id => ({ agentId: id }))
        }
        if (!arraysEqual(freeChatMemorySpaceIds.value, agentOriginalMemorySpaceIds.value)) {
            updates.memorySpaces = [...freeChatMemorySpaceIds.value]
        }
        if (!arraysEqual(freeChatSkillIds.value, agentOriginalSkillIds.value)) {
            updates.skills = [...freeChatSkillIds.value]
        }
        if (sessionSystemPrompt.value !== agentOriginalSystemPrompt.value) updates.systemPrompt = sessionSystemPrompt.value
        if (sessionThinkingEnabled.value !== agentOriginalThinkingEnabled.value) updates.thinkingEnabled = sessionThinkingEnabled.value
        if (sessionAutoToolRouting.value !== agentOriginalAutoToolRouting.value) updates.autoToolRouting = sessionAutoToolRouting.value
        if (sessionAutoMemory.value !== agentOriginalAutoMemory.value) updates.autoMemory = sessionAutoMemory.value
        if (sessionAutoSkillRouting.value !== agentOriginalAutoSkillRouting.value) updates.autoSkillRouting = sessionAutoSkillRouting.value

        if (sessionProviderOverride.value !== null) {
            updates.providerId = sessionProviderOverride.value
            updates.model = sessionModelOverride.value ?? null
        } else if (sessionModelOverride.value !== null && sessionModelOverride.value !== agentOriginalModel.value) {
            updates.model = sessionModelOverride.value
        }

        if (Object.keys(updates).length === 0) return
        await agentDefs.update(activeAgentId.value, updates)

        setAgentBaseline(currentPreset(), 'model' in updates ? updates.model as string | null : agentOriginalModel.value, 'providerId' in updates ? updates.providerId as string | null : agentOriginalProviderId.value)
        sessionModelOverride.value = null
        sessionProviderOverride.value = null
    }

    function applyAgentSelection(id: string | null): void {
        if (!activeAgentId.value) captureFreeChatPreset()
        activeAgentId.value = id
        if (id) {
            sessionStorage.setItem(SK_ACTIVE_AGENT, id)
            const { preset, model, providerId } = agentPreset(id)
            applyPreset(preset)
            setAgentBaseline(preset, model, providerId)
        } else {
            sessionStorage.removeItem(SK_ACTIVE_AGENT)
            ensureFreeChatPreset()
            applyPreset(freeChatPreset.value || regularFreeChatPreset())
            setAgentBaseline(regularFreeChatPreset(), null, null)
        }
    }

    async function setActiveAgent(id: string | null) {
        applyAgentSelection(id)
        activeConversationId.value = null
        messages.value = []
        agentStore.setActiveViewConversation(null)
        agentStore.clearExecutionState()
        agentStore.clearOrchestrationState()
        await loadConversations()
    }

    function setConversationAgent(id: string | null): void {
        applyAgentSelection(id)
    }

    function setSessionModel(model: string | null, providerId?: string | null): void {
        sessionModelOverride.value = model || null
        sessionProviderOverride.value = (model ? providerId : null) || null
        captureFreeChatPreset()
    }

    function syncAgentBaseline(): void {
        if (!activeAgentId.value) {
            ensureFreeChatPreset()
            return
        }
        const { preset, model, providerId } = agentPreset(activeAgentId.value)
        applyPreset(preset)
        setAgentBaseline(preset, model, providerId)
    }

    return {
        activeAgentId,
        sessionModelOverride,
        sessionProviderOverride,
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
        hasFreeChatOverrides,
        markOverridesModified,
        resetAgentOverrides,
        resetToDefaults,
        applyOverridesToAgent,
        setActiveAgent,
        setConversationAgent,
        setSessionModel,
        syncAgentBaseline,
        setFreeChatDefaultMemorySpaceIds,
        ensureFreeChatPreset,
        captureFreeChatPreset,
    }
}
