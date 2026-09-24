import { ref, computed, watch, type Ref, type ComputedRef } from 'vue'
import { useAgentStore, type ToolInfo } from '../stores/agent-runtime.store'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import type { Conversation, DisplayMessage } from '../stores/chat.store'
import type { ConversationExecutionConfig, ReasoningEffort } from '@shared/types'
import { SK_ACTIVE_AGENT, SK_FREE_CHAT_MODEL, SK_FREE_CHAT_PROVIDER } from '../utils/storage-keys'
import { syncPrefsToElectron } from '../utils/electron-prefs'
import { isAutoManagedBuiltInToolName, isBuiltInNamespaceId } from '../utils/internal-tools'
import { DEFAULT_FREE_CHAT_SYSTEM_PROMPT } from '../utils/default-system-prompts'

interface ChatPreset {
    tools: string[]
    subAgentIds: string[]
    memoryFolderIds: string[]
    systemPrompt: string
    thinkingEnabled: boolean
    reasoningEffort: ReasoningEffort
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
    sessionReasoningEffort: Ref<ReasoningEffort>
    sessionAutoToolRouting: Ref<boolean>
    sessionAutoMemory: Ref<boolean>
    selectedToolNames: Ref<string[]>
    agentOriginalSystemPrompt: Ref<string>
    freeChatSubAgentIds: Ref<string[]>
    freeChatMemoryFolderIds: Ref<string[]>
    agentOriginalTools: Ref<string[]>
    agentOriginalSubAgentIds: Ref<string[]>
    agentOriginalMemoryFolderIds: Ref<string[]>
    freeChatMemorySelectionInitialized: Ref<boolean>
    hasAgentOverrides: ComputedRef<boolean>
    agentOverrideFields: ComputedRef<string[]>
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
    setSessionReasoningEffort(effort: ReasoningEffort | 'off'): void
    syncAgentBaseline(): void
    setFreeChatDefaultMemoryFolderIds(ids: string[]): void
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
        memoryFolderIds: [...preset.memoryFolderIds],
    }
}

function presetsEqualWithoutProviderModel(a: ChatPreset, b: ChatPreset): boolean {
    return (
        arraysEqual(a.tools, b.tools) &&
        arraysEqual(a.subAgentIds, b.subAgentIds) &&
        arraysEqual(a.memoryFolderIds, b.memoryFolderIds) &&
        a.systemPrompt === b.systemPrompt &&
        a.thinkingEnabled === b.thinkingEnabled &&
        a.reasoningEffort === b.reasoningEffort &&
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
        loadStoredValue(SK_ACTIVE_AGENT) || sessionStorage.getItem(SK_ACTIVE_AGENT) || null
    )
    const freeChatModelOverride = ref<string | null>(loadStoredValue(SK_FREE_CHAT_MODEL))
    const freeChatProviderOverride = ref<string | null>(loadStoredValue(SK_FREE_CHAT_PROVIDER))
    const sessionModelOverride = ref<string | null>(activeAgentId.value ? null : freeChatModelOverride.value)
    const sessionProviderOverride = ref<string | null>(activeAgentId.value ? null : freeChatProviderOverride.value)
    const sessionSystemPrompt = ref<string>('')
    const sessionThinkingEnabled = ref<boolean>(true)
    const sessionReasoningEffort = ref<ReasoningEffort>('medium')
    const sessionAutoToolRouting = ref<boolean>(!activeAgentId.value)
    const sessionAutoMemory = ref<boolean>(true)
    const selectedToolNames = ref<string[]>([])
    const agentOriginalAutoToolRouting = ref<boolean>(false)
    const agentOriginalAutoMemory = ref<boolean>(true)
    const agentOriginalThinkingEnabled = ref<boolean>(true)
    const agentOriginalReasoningEffort = ref<ReasoningEffort>('medium')
    const agentOriginalSystemPrompt = ref<string>('')
    const agentOriginalModelOverride = ref<string | null>(null)
    const agentOriginalProviderOverride = ref<string | null>(null)
    const freeChatSubAgentIds = ref<string[]>([])
    const freeChatMemoryFolderIds = ref<string[]>([])
    const freeChatMemorySelectionInitialized = ref<boolean>(false)
    const agentOriginalTools = ref<string[]>([])
    const agentOriginalSubAgentIds = ref<string[]>([])
    const agentOriginalMemoryFolderIds = ref<string[]>([])
    const freeChatDefaultMemoryFolderIds = ref<string[]>([])
    const freeChatPreset = ref<ChatPreset | null>(null)
    let freeChatToolsFollowDefaults = true

    function filterToolsForChatContext(names: string[], _hasAgent = Boolean(activeAgentId.value)): string[] {
        return [...names]
    }

    function selectableToolKeys(): Set<string> {
        return new Set(
            agentStore.availableTools
                .filter((tool) => !(isBuiltInNamespaceId(tool.namespace.id) && isAutoManagedBuiltInToolName(tool.name)))
                .map((tool) => tool.key)
        )
    }

    function defaultFreeChatToolKeys(tools: ToolInfo[]): string[] {
        const defaultNames = new Set(['manage_mcp', 'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete'])
        return tools
            .filter((tool) => isBuiltInNamespaceId(tool.namespace.id) && defaultNames.has(tool.name))
            .map((tool) => tool.key)
    }

    watch(() => agentStore.availableTools, (tools, previousTools) => {
        const availableKeys = selectableToolKeys()
        const filtered = selectedToolNames.value.filter((name) => availableKeys.has(name))
        if (activeAgentId.value) {
            agentOriginalTools.value = agentOriginalTools.value.filter((name) => availableKeys.has(name))
        }
        const previousDefaults = defaultFreeChatToolKeys(previousTools ?? [])
        const nextDefaults = defaultFreeChatToolKeys(tools)
        const followsDefaults = !activeAgentId.value && freeChatToolsFollowDefaults && arraysEqual(filtered, previousDefaults)
        if (freeChatToolsFollowDefaults && freeChatPreset.value && arraysEqual(freeChatPreset.value.tools, previousDefaults)) {
            freeChatPreset.value = { ...freeChatPreset.value, tools: nextDefaults }
        }
        if (followsDefaults && freeChatMemorySelectionInitialized.value) {
            selectedToolNames.value = nextDefaults
        } else if (!arraysEqual(filtered, selectedToolNames.value)) {
            selectedToolNames.value = filtered
            captureFreeChatPreset()
        }
    }, { deep: true })

    function regularFreeChatPreset(): ChatPreset {
        return {
            tools: defaultFreeChatToolKeys(agentStore.availableTools),
            subAgentIds: [],
            memoryFolderIds: [...freeChatDefaultMemoryFolderIds.value],
            systemPrompt: DEFAULT_FREE_CHAT_SYSTEM_PROMPT,
            thinkingEnabled: true,
            reasoningEffort: 'medium',
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
            memoryFolderIds: [...freeChatMemoryFolderIds.value],
            systemPrompt: sessionSystemPrompt.value,
            thinkingEnabled: sessionThinkingEnabled.value,
            reasoningEffort: sessionReasoningEffort.value,
            autoToolRouting: sessionAutoToolRouting.value,
            autoMemory: sessionAutoMemory.value,
            modelOverride: sessionModelOverride.value,
            providerOverride: sessionProviderOverride.value,
        }
    }

    function applyPreset(preset: ChatPreset): void {
        selectedToolNames.value = filterToolsForChatContext(preset.tools)
        freeChatSubAgentIds.value = [...preset.subAgentIds]
        freeChatMemoryFolderIds.value = [...preset.memoryFolderIds]
        freeChatMemorySelectionInitialized.value = true
        sessionSystemPrompt.value = preset.systemPrompt
        sessionThinkingEnabled.value = preset.thinkingEnabled
        sessionReasoningEffort.value = preset.reasoningEffort
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
        agentOriginalMemoryFolderIds.value = [...preset.memoryFolderIds]
        agentOriginalSystemPrompt.value = preset.systemPrompt
        agentOriginalThinkingEnabled.value = preset.thinkingEnabled
        agentOriginalReasoningEffort.value = preset.reasoningEffort
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
                tools: agent?.tools?.length ? comparableAgentTools(agent.tools) : [],
                subAgentIds: agent?.subAgents?.map(s => s.agentId) ?? [],
                memoryFolderIds: agent?.memoryFolders?.length ? [...agent.memoryFolders] : [],
                systemPrompt: agent?.systemPrompt || '',
                thinkingEnabled: agent?.thinkingEnabled !== false,
                reasoningEffort: agent?.reasoningEffort || 'medium',
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
        if (!activeAgentId.value) freeChatToolsFollowDefaults = false
        const availableKeys = selectableToolKeys()
        const seen = new Set<string>()
        selectedToolNames.value = names.filter((name) => {
            if (!availableKeys.has(name) || seen.has(name)) return false
            seen.add(name)
            return true
        })
        captureFreeChatPreset()
    }

    function setFreeChatDefaultMemoryFolderIds(ids: string[]): void {
        const nextIds = [...ids]
        const previousDefault = regularFreeChatPreset()
        freeChatDefaultMemoryFolderIds.value = nextIds
        const nextDefault = regularFreeChatPreset()
        if (!freeChatPreset.value) {
            freeChatPreset.value = clonePreset(nextDefault)
        } else if (presetsEqualWithoutProviderModel(freeChatPreset.value, previousDefault)) {
            freeChatPreset.value = {
                ...clonePreset(nextDefault),
                modelOverride: freeChatPreset.value.modelOverride,
                providerOverride: freeChatPreset.value.providerOverride,
            }
        }
        if (
            !activeAgentId.value &&
            (
                !freeChatMemorySelectionInitialized.value ||
                presetsEqualWithoutProviderModel(currentPreset(), previousDefault)
            )
        ) {
            applyPreset(freeChatPreset.value)
        }
    }

    const agentOverrideFields = computed(() => {
        if (!activeAgentId.value) return []
        const { preset, model, providerId } = agentPreset(activeAgentId.value)
        const fields: string[] = []
        if (!arraysEqual(selectedToolNames.value, preset.tools)) fields.push('Tools')
        if (!arraysEqual(freeChatSubAgentIds.value, preset.subAgentIds)) fields.push('Sub-agents')
        if (!arraysEqual(freeChatMemoryFolderIds.value, preset.memoryFolderIds)) fields.push('Memory folders')
        if (sessionSystemPrompt.value !== preset.systemPrompt) fields.push('System prompt')
        if (sessionThinkingEnabled.value !== preset.thinkingEnabled) fields.push('Thinking mode')
        if (sessionReasoningEffort.value !== preset.reasoningEffort) fields.push('Reasoning effort')
        if (sessionAutoToolRouting.value !== preset.autoToolRouting) fields.push('Automatic tool routing')
        if (sessionAutoMemory.value !== preset.autoMemory) fields.push('Automatic memory')

        const effectiveProvider = sessionProviderOverride.value ?? providerId
        const effectiveModel = sessionProviderOverride.value && !sessionModelOverride.value
            ? null
            : sessionModelOverride.value ?? model
        if (effectiveProvider !== providerId || effectiveModel !== model) fields.push('Model / provider')
        return fields
    })

    const hasAgentOverrides = computed(() => agentOverrideFields.value.length > 0)

    const hasFreeChatOverrides = computed(() => {
        if (activeAgentId.value) return false
        return !presetsEqualWithoutProviderModel(currentPreset(), regularFreeChatPreset())
    })

    function markOverridesModified(): void {
        captureFreeChatPreset()
    }

    function resetAgentOverrides(): void {
        if (!activeAgentId.value) return
        const { preset } = agentPreset(activeAgentId.value)
        applyPreset(preset)
        setAgentBaseline(preset)
    }

    function resetToDefaults(): void {
        if (activeAgentId.value) {
            resetAgentOverrides()
            return
        }
        const modelOverride = sessionModelOverride.value
        const providerOverride = sessionProviderOverride.value
        const preset = regularFreeChatPreset()
        freeChatToolsFollowDefaults = true
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
        if (!arraysEqual(freeChatMemoryFolderIds.value, actualPreset.memoryFolderIds)) {
            updates.memoryFolders = [...freeChatMemoryFolderIds.value]
        }
        if (sessionSystemPrompt.value !== actualPreset.systemPrompt) updates.systemPrompt = sessionSystemPrompt.value
        if (sessionThinkingEnabled.value !== actualPreset.thinkingEnabled) updates.thinkingEnabled = sessionThinkingEnabled.value
        if (sessionReasoningEffort.value !== actualPreset.reasoningEffort) updates.reasoningEffort = sessionReasoningEffort.value
        if (sessionAutoToolRouting.value !== actualPreset.autoToolRouting) updates.autoToolRouting = sessionAutoToolRouting.value
        if (sessionAutoMemory.value !== actualPreset.autoMemory) updates.autoMemory = sessionAutoMemory.value

        const nextProviderId = sessionProviderOverride.value ?? actualProviderId
        // A provider-only override deliberately means "use that provider's
        // default". Persist an empty model instead of pairing the new provider
        // with the agent's previous model.
        const nextModel = sessionProviderOverride.value && !sessionModelOverride.value
            ? ''
            : sessionModelOverride.value ?? actualModel
        if (nextProviderId !== actualProviderId) {
            updates.providerId = nextProviderId
            updates.model = nextModel
        } else if (nextModel !== actualModel) {
            updates.model = nextModel
        }

        if (Object.keys(updates).length === 0) {
            resetAgentOverrides()
            return
        }
        await agentDefs.update(activeAgentId.value, updates)
        applyAgentSelection(activeAgentId.value)
    }

    function applyAgentSelection(id: string | null): void {
        if (!activeAgentId.value) captureFreeChatPreset()
        activeAgentId.value = id
        if (id) {
            sessionStorage.setItem(SK_ACTIVE_AGENT, id)
            persistStoredValue(SK_ACTIVE_AGENT, id)
            const { preset } = agentPreset(id)
            applyPreset(preset)
            setAgentBaseline(preset)
        } else {
            sessionStorage.removeItem(SK_ACTIVE_AGENT)
            persistStoredValue(SK_ACTIVE_AGENT, null)
            ensureFreeChatPreset()
            applyPreset(freeChatPreset.value || regularFreeChatPreset())
            restoreFreeChatModelSelection()
            setAgentBaseline(regularFreeChatPreset())
        }
        syncPrefsToElectron()
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

    function normalizeToolKeys(names: string[], hasAgent = Boolean(activeAgentId.value)): string[] {
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
        return filterToolsForChatContext(normalized, hasAgent)
    }

    function comparableAgentTools(names: string[]): string[] {
        if (!agentStore.availableTools.length) return [...new Set(names)]
        const selectableKeys = new Set(
            agentStore.availableTools
                .filter((tool) => !(isBuiltInNamespaceId(tool.namespace.id) && isAutoManagedBuiltInToolName(tool.name)))
                .map((tool) => tool.key)
        )
        return normalizeToolKeys(names, true).filter((name) => selectableKeys.has(name))
    }

    function restoreConversationConfig(config: ConversationExecutionConfig): void {
        if (!activeAgentId.value) freeChatToolsFollowDefaults = false
        const activeAgent = activeAgentId.value ? useAgentDefinitionsStore().get(activeAgentId.value) : null
        const restoredModel = config.model || null
        const restoredProviderId = config.providerId || null
        const matchesAgentModel = Boolean(activeAgent) &&
            restoredModel === (activeAgent?.model || null) &&
            restoredProviderId === (activeAgent?.providerId || null)
        const preset: ChatPreset = {
            tools: normalizeToolKeys(config.allowedTools),
            subAgentIds: config.subAgents.map((subAgent) => subAgent.agentId),
            memoryFolderIds: [...config.memoryFolderIds],
            systemPrompt: config.systemPrompt,
            thinkingEnabled: config.thinkingEnabled,
            reasoningEffort: config.reasoningEffort || 'medium',
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
        if (activeAgentId.value) {
            const agentDefs = useAgentDefinitionsStore()
            const activeAgent = agentDefs.get(activeAgentId.value)
            if (!model && providerId) {
                // Preserve a provider-only override even when it is the same
                // provider as the agent. This is distinct from agent default.
                sessionProviderOverride.value = providerId
                sessionModelOverride.value = null
                markOverridesModified()
                return
            }
            const nextProviderId = providerId || activeAgent?.providerId || null
            sessionProviderOverride.value = nextProviderId !== (activeAgent?.providerId || null) ? nextProviderId : null
            sessionModelOverride.value = (model || null) !== (activeAgent?.model || null) ? (model || null) : null
            markOverridesModified()
            return
        }

        sessionModelOverride.value = model || null
        sessionProviderOverride.value = providerId || null
        freeChatModelOverride.value = sessionModelOverride.value
        freeChatProviderOverride.value = sessionProviderOverride.value
        persistStoredValue(SK_FREE_CHAT_MODEL, freeChatModelOverride.value)
        persistStoredValue(SK_FREE_CHAT_PROVIDER, freeChatProviderOverride.value)
    }

    function setSessionReasoningEffort(effort: ReasoningEffort | 'off'): void {
        sessionThinkingEnabled.value = effort !== 'off'
        if (effort !== 'off') sessionReasoningEffort.value = effort
        markOverridesModified()
    }

    function syncAgentBaseline(): void {
        if (!activeAgentId.value) {
            freeChatToolsFollowDefaults = true
            const preset = regularFreeChatPreset()
            freeChatPreset.value = clonePreset(preset)
            applyPreset(preset)
            restoreFreeChatModelSelection()
            setAgentBaseline(preset)
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
        sessionReasoningEffort,
        sessionAutoToolRouting,
        sessionAutoMemory,
        selectedToolNames,
        agentOriginalSystemPrompt,
        freeChatSubAgentIds,
        freeChatMemoryFolderIds,
        freeChatMemorySelectionInitialized,
        agentOriginalTools,
        agentOriginalSubAgentIds,
        agentOriginalMemoryFolderIds,
        hasAgentOverrides,
        agentOverrideFields,
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
        setSessionReasoningEffort,
        syncAgentBaseline,
        setFreeChatDefaultMemoryFolderIds,
        ensureFreeChatPreset,
        captureFreeChatPreset,
    }
}
