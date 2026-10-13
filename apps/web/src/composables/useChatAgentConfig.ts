import { ref, computed, watch, type Ref, type ComputedRef } from 'vue'
import { useAgentStore, type ToolInfo } from '../stores/agent-runtime.store'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import type { Conversation, DisplayMessage } from '../stores/chat.store'
import { useCynoStore } from '../stores/cyno.store'
import type { ConversationExecutionConfig, CynoProfile, ReasoningEffort } from '@shared/types'
import { SK_ACTIVE_AGENT } from '../utils/storage-keys'
import { syncPrefsToElectron } from '../utils/electron-prefs'
import { isAutoManagedBuiltInToolName, isBuiltInNamespaceId } from '../utils/internal-tools'
import { defaultCynoToolKeys } from '../utils/cyno-defaults'

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
    sessionSubAgentIds: Ref<string[]>
    sessionMemoryFolderIds: Ref<string[]>
    agentOriginalTools: Ref<string[]>
    agentOriginalSubAgentIds: Ref<string[]>
    agentOriginalMemoryFolderIds: Ref<string[]>
    sessionMemorySelectionInitialized: Ref<boolean>
    hasAgentOverrides: ComputedRef<boolean>
    agentOverrideFields: ComputedRef<string[]>
    cynoOverrideFields: ComputedRef<string[]>
    hasCynoOverrides: ComputedRef<boolean>
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
    setCynoDefaultMemoryFolderIds(ids: string[]): void
    ensureCynoPreset(): void
    captureCynoPreset(): void
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

/** A profile's model choice as session overrides; empty means the app default. */
function profileModel(profile: CynoProfile | null): { model: string | null; providerId: string | null } {
    return { model: profile?.model || null, providerId: profile?.providerId || null }
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
    // Cyno's profile holds the defaults for chats without an agent ("Cyno chats").
    const cyno = useCynoStore()

    const activeAgentId = ref<string | null>(
        loadStoredValue(SK_ACTIVE_AGENT) || sessionStorage.getItem(SK_ACTIVE_AGENT) || null
    )
    const sessionModelOverride = ref<string | null>(activeAgentId.value ? null : profileModel(cyno.profile).model)
    const sessionProviderOverride = ref<string | null>(activeAgentId.value ? null : profileModel(cyno.profile).providerId)
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
    const sessionSubAgentIds = ref<string[]>([])
    const sessionMemoryFolderIds = ref<string[]>([])
    const sessionMemorySelectionInitialized = ref<boolean>(false)
    const agentOriginalTools = ref<string[]>([])
    const agentOriginalSubAgentIds = ref<string[]>([])
    const agentOriginalMemoryFolderIds = ref<string[]>([])
    const cynoDefaultMemoryFolderIds = ref<string[]>([])
    const cynoSessionPreset = ref<ChatPreset | null>(null)
    let cynoToolsFollowDefaults = true

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

    function cynoDefaultToolKeys(tools: ToolInfo[], profile: CynoProfile | null = cyno.profile): string[] {
        return defaultCynoToolKeys(tools, profile?.tools)
    }

    watch(() => agentStore.availableTools, (tools, previousTools) => {
        const availableKeys = selectableToolKeys()
        const filtered = selectedToolNames.value.filter((name) => availableKeys.has(name))
        if (activeAgentId.value) {
            agentOriginalTools.value = agentOriginalTools.value.filter((name) => availableKeys.has(name))
        }
        const previousDefaults = cynoDefaultToolKeys(previousTools ?? [])
        const nextDefaults = cynoDefaultToolKeys(tools)
        const followsDefaults = !activeAgentId.value && cynoToolsFollowDefaults && arraysEqual(filtered, previousDefaults)
        if (cynoToolsFollowDefaults && cynoSessionPreset.value && arraysEqual(cynoSessionPreset.value.tools, previousDefaults)) {
            cynoSessionPreset.value = { ...cynoSessionPreset.value, tools: nextDefaults }
        }
        if (followsDefaults && sessionMemorySelectionInitialized.value) {
            selectedToolNames.value = nextDefaults
        } else if (!arraysEqual(filtered, selectedToolNames.value)) {
            selectedToolNames.value = filtered
            captureCynoPreset()
        }
    }, { deep: true })

    /** Cyno's defaults; a profile without a memory selection uses All Memory. */
    function cynoDefaultPreset(profile: CynoProfile | null = cyno.profile): ChatPreset {
        return {
            tools: cynoDefaultToolKeys(agentStore.availableTools, profile),
            subAgentIds: profile?.subAgents.map((assignment) => assignment.agentId) ?? [],
            memoryFolderIds: profile?.memoryFolders ? [...profile.memoryFolders] : [...cynoDefaultMemoryFolderIds.value],
            systemPrompt: profile?.systemPrompt ?? '',
            thinkingEnabled: profile?.thinkingEnabled ?? true,
            reasoningEffort: profile?.reasoningEffort ?? 'medium',
            autoToolRouting: profile?.autoToolRouting ?? true,
            autoMemory: profile?.autoMemory ?? true,
            modelOverride: null,
            providerOverride: null,
        }
    }

    function currentPreset(): ChatPreset {
        return {
            tools: [...selectedToolNames.value],
            subAgentIds: [...sessionSubAgentIds.value],
            memoryFolderIds: [...sessionMemoryFolderIds.value],
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
        sessionSubAgentIds.value = [...preset.subAgentIds]
        sessionMemoryFolderIds.value = [...preset.memoryFolderIds]
        sessionMemorySelectionInitialized.value = true
        sessionSystemPrompt.value = preset.systemPrompt
        sessionThinkingEnabled.value = preset.thinkingEnabled
        sessionReasoningEffort.value = preset.reasoningEffort
        sessionAutoToolRouting.value = preset.autoToolRouting
        sessionAutoMemory.value = preset.autoMemory
        sessionModelOverride.value = preset.modelOverride
        sessionProviderOverride.value = preset.providerOverride
    }

    function restoreCynoModelSelection(): void {
        const { model, providerId } = profileModel(cyno.profile)
        sessionModelOverride.value = model
        sessionProviderOverride.value = providerId
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

    function ensureCynoPreset(): void {
        if (!cynoSessionPreset.value) {
            cynoSessionPreset.value = cynoDefaultPreset()
        }
        if (!activeAgentId.value && !sessionMemorySelectionInitialized.value) {
            applyPreset(cynoSessionPreset.value)
        }
    }

    function captureCynoPreset(): void {
        if (activeAgentId.value) return
        cynoSessionPreset.value = currentPreset()
    }

    function setSelectedToolNames(names: string[]): void {
        if (!activeAgentId.value) cynoToolsFollowDefaults = false
        const availableKeys = selectableToolKeys()
        const seen = new Set<string>()
        selectedToolNames.value = names.filter((name) => {
            if (!availableKeys.has(name) || seen.has(name)) return false
            seen.add(name)
            return true
        })
        captureCynoPreset()
    }

    function setCynoDefaultMemoryFolderIds(ids: string[]): void {
        const previousDefault = cynoDefaultPreset()
        cynoDefaultMemoryFolderIds.value = [...ids]
        refreshCynoDefaults(previousDefault)
    }

    /**
     * Cyno's defaults changed (profile loaded or edited, default memory known).
     * A new chat, or one still on the old defaults, moves to the new ones.
     */
    function refreshCynoDefaults(previousDefault: ChatPreset): void {
        const nextDefault = cynoDefaultPreset()
        if (!cynoSessionPreset.value) {
            cynoSessionPreset.value = clonePreset(nextDefault)
        } else if (presetsEqualWithoutProviderModel(cynoSessionPreset.value, previousDefault)) {
            cynoSessionPreset.value = {
                ...clonePreset(nextDefault),
                modelOverride: cynoSessionPreset.value.modelOverride,
                providerOverride: cynoSessionPreset.value.providerOverride,
            }
        }
        if (
            !activeAgentId.value &&
            (
                !sessionMemorySelectionInitialized.value ||
                presetsEqualWithoutProviderModel(currentPreset(), previousDefault)
            )
        ) {
            applyPreset(cynoSessionPreset.value)
        }
    }

    function presetChangedFields(preset: ChatPreset): string[] {
        const fields: string[] = []
        if (!arraysEqual(selectedToolNames.value, preset.tools)) fields.push('Tools')
        if (!arraysEqual(sessionSubAgentIds.value, preset.subAgentIds)) fields.push('Sub-agents')
        if (!arraysEqual(sessionMemoryFolderIds.value, preset.memoryFolderIds)) fields.push('Memory folders')
        if (sessionSystemPrompt.value !== preset.systemPrompt) fields.push('System prompt')
        if (sessionThinkingEnabled.value !== preset.thinkingEnabled) fields.push('Thinking mode')
        if (sessionReasoningEffort.value !== preset.reasoningEffort) fields.push('Reasoning effort')
        if (sessionAutoToolRouting.value !== preset.autoToolRouting) fields.push('Automatic tool routing')
        if (sessionAutoMemory.value !== preset.autoMemory) fields.push('Automatic memory')
        return fields
    }

    const cynoOverrideFields = computed(() =>
        activeAgentId.value ? [] : presetChangedFields(cynoDefaultPreset())
    )

    const agentOverrideFields = computed(() => {
        if (!activeAgentId.value) return []
        const { preset, model, providerId } = agentPreset(activeAgentId.value)
        const fields = presetChangedFields(preset)

        const effectiveProvider = sessionProviderOverride.value ?? providerId
        const effectiveModel = sessionProviderOverride.value && !sessionModelOverride.value
            ? null
            : sessionModelOverride.value ?? model
        if (effectiveProvider !== providerId || effectiveModel !== model) fields.push('Model / provider')
        return fields
    })

    const hasAgentOverrides = computed(() => agentOverrideFields.value.length > 0)

    const hasCynoOverrides = computed(() => {
        if (activeAgentId.value) return false
        return !presetsEqualWithoutProviderModel(currentPreset(), cynoDefaultPreset())
    })

    function markOverridesModified(): void {
        captureCynoPreset()
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
        const preset = cynoDefaultPreset()
        cynoToolsFollowDefaults = true
        cynoSessionPreset.value = clonePreset(preset)
        applyPreset(preset)
        sessionModelOverride.value = modelOverride
        sessionProviderOverride.value = providerOverride
    }

    /** Save the current chat's changes as Cyno's defaults. */
    async function applyOverridesToCyno(): Promise<void> {
        const defaults = cynoDefaultPreset()
        const updates: Partial<CynoProfile> = {}
        if (!arraysEqual(selectedToolNames.value, defaults.tools)) updates.tools = [...selectedToolNames.value]
        if (!arraysEqual(sessionSubAgentIds.value, defaults.subAgentIds)) {
            updates.subAgents = sessionSubAgentIds.value.map((agentId) => ({ agentId }))
        }
        if (!arraysEqual(sessionMemoryFolderIds.value, defaults.memoryFolderIds)) updates.memoryFolders = [...sessionMemoryFolderIds.value]
        if (sessionSystemPrompt.value !== defaults.systemPrompt) updates.systemPrompt = sessionSystemPrompt.value
        if (sessionThinkingEnabled.value !== defaults.thinkingEnabled) updates.thinkingEnabled = sessionThinkingEnabled.value
        if (sessionReasoningEffort.value !== defaults.reasoningEffort) updates.reasoningEffort = sessionReasoningEffort.value
        if (sessionAutoToolRouting.value !== defaults.autoToolRouting) updates.autoToolRouting = sessionAutoToolRouting.value
        if (sessionAutoMemory.value !== defaults.autoMemory) updates.autoMemory = sessionAutoMemory.value
        if (Object.keys(updates).length) await cyno.update(updates)
        syncAgentBaseline()
    }

    async function applyOverridesToAgent(): Promise<void> {
        if (!activeAgentId.value) {
            await applyOverridesToCyno()
            return
        }
        const agentDefs = useAgentDefinitionsStore()
        const updates: Record<string, unknown> = {}
        const { preset: actualPreset, model: actualModel, providerId: actualProviderId } = agentPreset(activeAgentId.value)

        if (!arraysEqual(selectedToolNames.value, actualPreset.tools)) {
            updates.tools = [...selectedToolNames.value]
        }
        if (!arraysEqual(sessionSubAgentIds.value, actualPreset.subAgentIds)) {
            updates.subAgents = sessionSubAgentIds.value.map(id => ({ agentId: id }))
        }
        if (!arraysEqual(sessionMemoryFolderIds.value, actualPreset.memoryFolderIds)) {
            updates.memoryFolders = [...sessionMemoryFolderIds.value]
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
        if (!activeAgentId.value) captureCynoPreset()
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
            ensureCynoPreset()
            applyPreset(cynoSessionPreset.value || cynoDefaultPreset())
            restoreCynoModelSelection()
            setAgentBaseline(cynoDefaultPreset())
        }
        syncPrefsToElectron()
    }

    async function setActiveAgent(id: string | null) {
        applyAgentSelection(id)
        activeConversationId.value = null
        messages.value = []
        agentStore.setActiveViewConversation(null)
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
        if (!activeAgentId.value) cynoToolsFollowDefaults = false
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
            captureCynoPreset()
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
        // The model picked in a Cyno chat stays Cyno's model for later chats and channels.
        const current = profileModel(cyno.profile)
        if (current.model !== sessionModelOverride.value || current.providerId !== sessionProviderOverride.value) {
            void cyno.update({ model: sessionModelOverride.value ?? '', providerId: sessionProviderOverride.value ?? '' })
                .catch(() => { /* The chat keeps its selection; the default updates on the next successful save. */ })
        }
    }

    function setSessionReasoningEffort(effort: ReasoningEffort | 'off'): void {
        sessionThinkingEnabled.value = effort !== 'off'
        if (effort !== 'off') sessionReasoningEffort.value = effort
        markOverridesModified()
    }

    function syncAgentBaseline(): void {
        if (!activeAgentId.value) {
            cynoToolsFollowDefaults = true
            const preset = cynoDefaultPreset()
            cynoSessionPreset.value = clonePreset(preset)
            applyPreset(preset)
            restoreCynoModelSelection()
            setAgentBaseline(preset)
            return
        }
        const { preset } = agentPreset(activeAgentId.value)
        applyPreset(preset)
        setAgentBaseline(preset)
    }

    watch(() => cyno.profile, (next, previous) => {
        const previousModel = profileModel(previous ?? null)
        refreshCynoDefaults(cynoDefaultPreset(previous ?? null))
        // A Cyno chat still on the old default model follows the new one.
        if (!activeAgentId.value
            && sessionModelOverride.value === previousModel.model
            && sessionProviderOverride.value === previousModel.providerId) {
            restoreCynoModelSelection()
            if (cynoSessionPreset.value) {
                cynoSessionPreset.value = {
                    ...cynoSessionPreset.value,
                    modelOverride: sessionModelOverride.value,
                    providerOverride: sessionProviderOverride.value,
                }
            }
        }
    })

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
        sessionSubAgentIds,
        sessionMemoryFolderIds,
        sessionMemorySelectionInitialized,
        agentOriginalTools,
        agentOriginalSubAgentIds,
        agentOriginalMemoryFolderIds,
        hasAgentOverrides,
        agentOverrideFields,
        cynoOverrideFields,
        hasCynoOverrides,
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
        setCynoDefaultMemoryFolderIds,
        ensureCynoPreset,
        captureCynoPreset,
    }
}
