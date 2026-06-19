import { ref, computed, watch, type Ref, type ComputedRef } from 'vue'
import { useAgentStore } from '../stores/agent-runtime.store'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import type { Conversation, DisplayMessage } from '../stores/chat.store'
import type { ConversationExecutionConfig } from '@shared/types'
import { SK_ACTIVE_AGENT, SK_FREE_CHAT_MODEL, SK_FREE_CHAT_PROVIDER } from '../utils/storage-keys'

interface ChatPreset {
    tools: string[]
    subAgentIds: string[]
    memorySpaceIds: string[]
    systemPrompt: string
    thinkingEnabled: boolean
    autoToolRouting: boolean
    autoMemory: boolean
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
    selectedToolNames: Ref<string[]>
    agentOriginalSystemPrompt: Ref<string>
    freeChatSubAgentIds: Ref<string[]>
    freeChatMemorySpaceIds: Ref<string[]>
    agentOriginalTools: Ref<string[]>
    agentOriginalSubAgentIds: Ref<string[]>
    agentOriginalMemorySpaceIds: Ref<string[]>
    freeChatMemorySelectionInitialized: Ref<boolean>
    hasAgentOverrides: ComputedRef<boolean>
    hasFreeChatOverrides: ComputedRef<boolean>
    markOverridesModified(): void
    setSelectedToolNames(names: string[]): void
    resetAgentOverrides(): void
    resetToDefaults(): void
    applyOverridesToAgent(): Promise<void>
    setActiveAgent(id: string | null): Promise<void>
    setConversationAgent(id: string | null): void
    restoreConversationConfig(config: ConversationExecutionConfig): void
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
    }
}

function presetsEqual(a: ChatPreset, b: ChatPreset): boolean {
    return (
        arraysEqual(a.tools, b.tools) &&
        arraysEqual(a.subAgentIds, b.subAgentIds) &&
        arraysEqual(a.memorySpaceIds, b.memorySpaceIds) &&
        a.systemPrompt === b.systemPrompt &&
        a.thinkingEnabled === b.thinkingEnabled &&
        a.autoToolRouting === b.autoToolRouting &&
        a.autoMemory === b.autoMemory &&
        a.modelOverride === b.modelOverride &&
        a.providerOverride === b.providerOverride
    )
}

function presetsEqualWithoutProviderModel(a: ChatPreset, b: ChatPreset): boolean {
    return (
        arraysEqual(a.tools, b.tools) &&
        arraysEqual(a.subAgentIds, b.subAgentIds) &&
        arraysEqual(a.memorySpaceIds, b.memorySpaceIds) &&
        a.systemPrompt === b.systemPrompt &&
        a.thinkingEnabled === b.thinkingEnabled &&
        a.autoToolRouting === b.autoToolRouting &&
        a.autoMemory === b.autoMemory
    )
}

function loadStoredValue(key: string): string | null {
    try {
        return localStorage.getItem(key) || null
    } catch {
        return null
    }
}

function persistStoredValue(key: string, value: string | null): void {
    try {
        if (value) {
            localStorage.setItem(key, value)
        } else {
            localStorage.removeItem(key)
        }
    } catch {
        // Storage can be unavailable in hardened browser contexts.
    }
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
    const freeChatModelOverride = ref<string | null>(loadStoredValue(SK_FREE_CHAT_MODEL))
    const freeChatProviderOverride = ref<string | null>(loadStoredValue(SK_FREE_CHAT_PROVIDER))
    const sessionModelOverride = ref<string | null>(activeAgentId.value ? null : freeChatModelOverride.value)
    const sessionProviderOverride = ref<string | null>(activeAgentId.value ? null : freeChatProviderOverride.value)
    const sessionSystemPrompt = ref<string>('')
    const sessionThinkingEnabled = ref<boolean>(true)
    const sessionAutoToolRouting = ref<boolean>(!activeAgentId.value)
    const sessionAutoMemory = ref<boolean>(true)
    const selectedToolNames = ref<string[]>([])
    const agentOriginalAutoToolRouting = ref<boolean>(false)
    const agentOriginalAutoMemory = ref<boolean>(true)
    const agentOriginalThinkingEnabled = ref<boolean>(true)
    const agentOriginalSystemPrompt = ref<string>('')
    const agentOriginalModelOverride = ref<string | null>(null)
    const agentOriginalProviderOverride = ref<string | null>(null)
    const freeChatSubAgentIds = ref<string[]>([])
    const freeChatMemorySpaceIds = ref<string[]>([])
    const freeChatMemorySelectionInitialized = ref<boolean>(false)
    const agentOriginalTools = ref<string[]>([])
    const agentOriginalSubAgentIds = ref<string[]>([])
    const agentOriginalMemorySpaceIds = ref<string[]>([])
    const freeChatDefaultMemorySpaceIds = ref<string[]>([])
    const freeChatPreset = ref<ChatPreset | null>(null)

    watch(() => agentStore.availableTools, (tools) => {
        const availableKeys = new Set(tools.map((tool) => tool.key))
        const filtered = selectedToolNames.value.filter((name) => availableKeys.has(name))
        if (activeAgentId.value) {
            agentOriginalTools.value = agentOriginalTools.value.filter((name) => availableKeys.has(name))
        }
        if (!arraysEqual(filtered, selectedToolNames.value)) {
            selectedToolNames.value = filtered
            captureFreeChatPreset()
        }
    }, { deep: true })

    function regularFreeChatPreset(): ChatPreset {
        return {
            tools: [],
            subAgentIds: [],
            memorySpaceIds: [...freeChatDefaultMemorySpaceIds.value],
            systemPrompt: '',
            thinkingEnabled: true,
            autoToolRouting: true,
            autoMemory: true,
            modelOverride: null,
            providerOverride: null,
        }
    }

    function currentPreset(): ChatPreset {
        return {
            tools: [...selectedToolNames.value],
            subAgentIds: [...freeChatSubAgentIds.value],
            memorySpaceIds: [...freeChatMemorySpaceIds.value],
            systemPrompt: sessionSystemPrompt.value,
            thinkingEnabled: sessionThinkingEnabled.value,
            autoToolRouting: sessionAutoToolRouting.value,
            autoMemory: sessionAutoMemory.value,
            modelOverride: sessionModelOverride.value,
            providerOverride: sessionProviderOverride.value,
        }
    }

    function applyPreset(preset: ChatPreset): void {
        selectedToolNames.value = [...preset.tools]
        freeChatSubAgentIds.value = [...preset.subAgentIds]
        freeChatMemorySpaceIds.value = [...preset.memorySpaceIds]
        freeChatMemorySelectionInitialized.value = true
        sessionSystemPrompt.value = preset.systemPrompt
        sessionThinkingEnabled.value = preset.thinkingEnabled
        sessionAutoToolRouting.value = preset.autoToolRouting
        sessionAutoMemory.value = preset.autoMemory
        sessionModelOverride.value = preset.modelOverride
        sessionProviderOverride.value = preset.providerOverride
    }

    function restoreFreeChatModelSelection(): void {
        sessionModelOverride.value = freeChatModelOverride.value
        sessionProviderOverride.value = freeChatProviderOverride.value
    }

    function setAgentBaseline(preset: ChatPreset): void {
        agentOriginalTools.value = [...preset.tools]
        agentOriginalSubAgentIds.value = [...preset.subAgentIds]
        agentOriginalMemorySpaceIds.value = [...preset.memorySpaceIds]
        agentOriginalSystemPrompt.value = preset.systemPrompt
        agentOriginalThinkingEnabled.value = preset.thinkingEnabled
        agentOriginalAutoToolRouting.value = preset.autoToolRouting
        agentOriginalAutoMemory.value = preset.autoMemory
        agentOriginalModelOverride.value = preset.modelOverride
        agentOriginalProviderOverride.value = preset.providerOverride
    }

    function agentPreset(id: string): { preset: ChatPreset; model: string | null; providerId: string | null } {
        const agentDefs = useAgentDefinitionsStore()
        const agent = agentDefs.get(id)
        return {
            preset: {
                tools: agent?.tools?.length ? [...agent.tools] : [],
                subAgentIds: agent?.subAgents?.map(s => s.agentId) ?? [],
                memorySpaceIds: agent?.memorySpaces?.length ? [...agent.memorySpaces] : [],
                systemPrompt: agent?.systemPrompt || '',
                thinkingEnabled: agent?.thinkingEnabled !== false,
                autoToolRouting: agent?.autoToolRouting === true,
                autoMemory: agent?.autoMemory === true,
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

    function setSelectedToolNames(names: string[]): void {
        const availableKeys = new Set(agentStore.availableTools.map((tool) => tool.key))
        const seen = new Set<string>()
        selectedToolNames.value = names.filter((name) => {
            if (!availableKeys.has(name) || seen.has(name)) return false
            seen.add(name)
            return true
        })
        captureFreeChatPreset()
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
            !arraysEqual(selectedToolNames.value, agentOriginalTools.value) ||
            !arraysEqual(freeChatSubAgentIds.value, agentOriginalSubAgentIds.value) ||
            !arraysEqual(freeChatMemorySpaceIds.value, agentOriginalMemorySpaceIds.value) ||
            sessionSystemPrompt.value !== agentOriginalSystemPrompt.value ||
            sessionThinkingEnabled.value !== agentOriginalThinkingEnabled.value ||
            sessionAutoToolRouting.value !== agentOriginalAutoToolRouting.value ||
            sessionAutoMemory.value !== agentOriginalAutoMemory.value ||
            sessionProviderOverride.value !== agentOriginalProviderOverride.value ||
            sessionModelOverride.value !== agentOriginalModelOverride.value
        )
    })

    const hasFreeChatOverrides = computed(() => {
        if (activeAgentId.value) return false
        return !presetsEqualWithoutProviderModel(currentPreset(), regularFreeChatPreset())
    })

    function markOverridesModified(): void {
        captureFreeChatPreset()
    }

    function resetAgentOverrides(): void {
        applyPreset({
            tools: [...agentOriginalTools.value],
            subAgentIds: [...agentOriginalSubAgentIds.value],
            memorySpaceIds: [...agentOriginalMemorySpaceIds.value],
            systemPrompt: agentOriginalSystemPrompt.value,
            thinkingEnabled: agentOriginalThinkingEnabled.value,
            autoToolRouting: agentOriginalAutoToolRouting.value,
            autoMemory: agentOriginalAutoMemory.value,
            modelOverride: agentOriginalModelOverride.value,
            providerOverride: agentOriginalProviderOverride.value,
        })
    }

    function resetToDefaults(): void {
        if (activeAgentId.value) {
            resetAgentOverrides()
            return
        }
        const modelOverride = sessionModelOverride.value
        const providerOverride = sessionProviderOverride.value
        const preset = regularFreeChatPreset()
        freeChatPreset.value = clonePreset(preset)
        applyPreset(preset)
        sessionModelOverride.value = modelOverride
        sessionProviderOverride.value = providerOverride
    }

    async function applyOverridesToAgent(): Promise<void> {
        if (!activeAgentId.value) return
        const agentDefs = useAgentDefinitionsStore()
        const updates: Record<string, unknown> = {}
        const { preset: actualPreset, model: actualModel, providerId: actualProviderId } = agentPreset(activeAgentId.value)

        if (!arraysEqual(selectedToolNames.value, actualPreset.tools)) {
            updates.tools = [...selectedToolNames.value]
        }
        if (!arraysEqual(freeChatSubAgentIds.value, actualPreset.subAgentIds)) {
            updates.subAgents = freeChatSubAgentIds.value.map(id => ({ agentId: id }))
        }
        if (!arraysEqual(freeChatMemorySpaceIds.value, actualPreset.memorySpaceIds)) {
            updates.memorySpaces = [...freeChatMemorySpaceIds.value]
        }
        if (sessionSystemPrompt.value !== actualPreset.systemPrompt) updates.systemPrompt = sessionSystemPrompt.value
        if (sessionThinkingEnabled.value !== actualPreset.thinkingEnabled) updates.thinkingEnabled = sessionThinkingEnabled.value
        if (sessionAutoToolRouting.value !== actualPreset.autoToolRouting) updates.autoToolRouting = sessionAutoToolRouting.value
        if (sessionAutoMemory.value !== actualPreset.autoMemory) updates.autoMemory = sessionAutoMemory.value

        const nextProviderId = sessionProviderOverride.value ?? actualProviderId
        const nextModel = sessionModelOverride.value ?? actualModel
        if (nextProviderId !== actualProviderId) {
            updates.providerId = nextProviderId
            updates.model = nextModel
        } else if (nextModel !== actualModel) {
            updates.model = nextModel
        }

        if (Object.keys(updates).length === 0) return
        await agentDefs.update(activeAgentId.value, updates)
        applyAgentSelection(activeAgentId.value)
    }

    function applyAgentSelection(id: string | null): void {
        if (!activeAgentId.value) captureFreeChatPreset()
        activeAgentId.value = id
        if (id) {
            sessionStorage.setItem(SK_ACTIVE_AGENT, id)
            const { preset } = agentPreset(id)
            applyPreset(preset)
            setAgentBaseline(preset)
        } else {
            sessionStorage.removeItem(SK_ACTIVE_AGENT)
            ensureFreeChatPreset()
            applyPreset(freeChatPreset.value || regularFreeChatPreset())
            restoreFreeChatModelSelection()
            setAgentBaseline(regularFreeChatPreset())
        }
    }

    async function setActiveAgent(id: string | null) {
        applyAgentSelection(id)
        activeConversationId.value = null
        messages.value = []
        agentStore.setActiveViewConversation(null)
        agentStore.clearExecutionState()
        agentStore.clearPlanningState()
        await loadConversations()
    }

    function setConversationAgent(id: string | null): void {
        applyAgentSelection(id)
    }

    function normalizeToolKeys(names: string[]): string[] {
        const tools = agentStore.availableTools
        const byKey = new Set(tools.map((tool) => tool.key))
        const byName = new Map<string, string[]>()
        for (const tool of tools) {
            for (const name of [tool.name, tool.executionName]) {
                const keys = byName.get(name) ?? []
                keys.push(tool.key)
                byName.set(name, keys)
            }
        }

        const seen = new Set<string>()
        const normalized: string[] = []
        for (const name of names) {
            const key = byKey.has(name)
                ? name
                : ((byName.get(name)?.length === 1) ? byName.get(name)![0] : null)
            if (!key || seen.has(key)) continue
            seen.add(key)
            normalized.push(key)
        }
        return normalized
    }

    function isEmptyLegacyExecutionConfig(config: ConversationExecutionConfig): boolean {
        return !config.allowedTools.length &&
            !config.subAgents.length &&
            !config.memorySpaceIds.length &&
            !config.systemPrompt &&
            !config.model &&
            !config.providerId &&
            config.autoToolRouting === false &&
            config.autoMemory === false
    }

    function restoreConversationConfig(config: ConversationExecutionConfig): void {
        if (activeAgentId.value && isEmptyLegacyExecutionConfig(config)) {
            const { preset } = agentPreset(activeAgentId.value)
            applyPreset(preset)
            setAgentBaseline(preset)
            return
        }

        const activeAgent = activeAgentId.value ? useAgentDefinitionsStore().get(activeAgentId.value) : null
        const restoredModel = config.model || null
        const restoredProviderId = config.providerId || null
        const matchesAgentModel = Boolean(activeAgent) &&
            restoredModel === (activeAgent?.model || null) &&
            restoredProviderId === (activeAgent?.providerId || null)
        const preset: ChatPreset = {
            tools: normalizeToolKeys(config.allowedTools),
            subAgentIds: config.subAgents.map((subAgent) => subAgent.agentId),
            memorySpaceIds: [...config.memorySpaceIds],
            systemPrompt: config.systemPrompt,
            thinkingEnabled: config.thinkingEnabled,
            autoToolRouting: config.autoToolRouting,
            autoMemory: config.autoMemory,
            modelOverride: activeAgent && matchesAgentModel ? null : restoredModel,
            providerOverride: activeAgent && matchesAgentModel ? null : restoredProviderId,
        }

        applyPreset(preset)
        if (activeAgentId.value) {
            setAgentBaseline(agentPreset(activeAgentId.value).preset)
        } else {
            captureFreeChatPreset()
        }
    }

    function setSessionModel(model: string | null, providerId?: string | null): void {
        sessionModelOverride.value = model || null
        if (activeAgentId.value) {
            const agentDefs = useAgentDefinitionsStore()
            const activeAgent = agentDefs.get(activeAgentId.value)
            sessionProviderOverride.value = providerId && providerId !== activeAgent?.providerId ? providerId : null
            markOverridesModified()
            return
        }

        sessionProviderOverride.value = providerId || null
        freeChatModelOverride.value = sessionModelOverride.value
        freeChatProviderOverride.value = sessionProviderOverride.value
        persistStoredValue(SK_FREE_CHAT_MODEL, freeChatModelOverride.value)
        persistStoredValue(SK_FREE_CHAT_PROVIDER, freeChatProviderOverride.value)
    }

    function syncAgentBaseline(): void {
        if (!activeAgentId.value) {
            ensureFreeChatPreset()
            restoreFreeChatModelSelection()
            return
        }
        const { preset } = agentPreset(activeAgentId.value)
        applyPreset(preset)
        setAgentBaseline(preset)
    }

    return {
        activeAgentId,
        sessionModelOverride,
        sessionProviderOverride,
        sessionSystemPrompt,
        sessionThinkingEnabled,
        sessionAutoToolRouting,
        sessionAutoMemory,
        selectedToolNames,
        agentOriginalSystemPrompt,
        freeChatSubAgentIds,
        freeChatMemorySpaceIds,
        freeChatMemorySelectionInitialized,
        agentOriginalTools,
        agentOriginalSubAgentIds,
        agentOriginalMemorySpaceIds,
        hasAgentOverrides,
        hasFreeChatOverrides,
        markOverridesModified,
        setSelectedToolNames,
        resetAgentOverrides,
        resetToDefaults,
        applyOverridesToAgent,
        setActiveAgent,
        setConversationAgent,
        restoreConversationConfig,
        setSessionModel,
        syncAgentBaseline,
        setFreeChatDefaultMemorySpaceIds,
        ensureFreeChatPreset,
        captureFreeChatPreset,
    }
}
