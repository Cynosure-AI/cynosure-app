import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref, watch } from 'vue'
import { useLocalStorage } from '@vueuse/core'
import { syncPrefsToElectron } from '@/utils/electron-prefs'
import {
    SK_THEME, SK_AUTO_EXPAND, SK_AUTO_EXPAND_TOOLS, SK_GENERATE_TITLE, SK_TITLE_PROVIDER, SK_TITLE_MODEL,
    SK_ENABLE_ENTITY_GRAPH, SK_ENTITY_GRAPH_PROVIDER, SK_ENTITY_GRAPH_MODEL,
    SK_TOOL_ROUTER_PROVIDER, SK_TOOL_ROUTER_MODEL,
    SK_MEMORY_ROUTER_PROVIDER, SK_MEMORY_ROUTER_MODEL,
    SK_CONTEXT_STRATEGY, SK_COMPACT_PROVIDER, SK_COMPACT_MODEL,
    SK_AGENT_CATEGORIES, SK_MA_CATEGORIES,
    SK_WHISPER_MODEL, SK_WHISPER_ENABLED, SK_WHISPER_QUANTIZATION, SK_WHISPER_LANGUAGE, SK_WHISPER_MIC_DEVICE,
} from '@/utils/storage-keys'

export type ThemeId = 'dark' | 'light' | 'arasaka' | 'midnight-purple' | 'cyberpunk'

export type ContextStrategy = 'sliding-window' | 'truncate-middle' | 'compact' | 'none'

export const usePreferencesStore = defineStore('preferences', () => {
    const theme = useLocalStorage<ThemeId>(SK_THEME, 'dark')
    const autoExpandSteps = useLocalStorage(SK_AUTO_EXPAND, false)
    const autoExpandToolCalls = useLocalStorage(SK_AUTO_EXPAND_TOOLS, false)
    const generateTitle = useLocalStorage(SK_GENERATE_TITLE, true)
    const titleProviderId = useLocalStorage(SK_TITLE_PROVIDER, '')
    const titleModel = useLocalStorage(SK_TITLE_MODEL, '')
    const enableEntityGraph = useLocalStorage(SK_ENABLE_ENTITY_GRAPH, true)
    const entityGraphProviderId = useLocalStorage(SK_ENTITY_GRAPH_PROVIDER, '')
    const entityGraphModel = useLocalStorage(SK_ENTITY_GRAPH_MODEL, '')
    const toolRouterProviderId = useLocalStorage(SK_TOOL_ROUTER_PROVIDER, '')
    const toolRouterModel = useLocalStorage(SK_TOOL_ROUTER_MODEL, '')
    const memoryRouterProviderId = useLocalStorage(SK_MEMORY_ROUTER_PROVIDER, '')
    const memoryRouterModel = useLocalStorage(SK_MEMORY_ROUTER_MODEL, '')
    const compactProviderId = useLocalStorage(SK_COMPACT_PROVIDER, '')
    const compactModel = useLocalStorage(SK_COMPACT_MODEL, '')
    const sidebarCollapsed = ref(false)
    const contextStrategy = useLocalStorage<ContextStrategy>(SK_CONTEXT_STRATEGY, 'sliding-window')

    const agentCategories = useLocalStorage<string[]>(SK_AGENT_CATEGORIES, [])
    const maCategories = useLocalStorage<string[]>(SK_MA_CATEGORIES, [])

    const whisperModel = useLocalStorage(SK_WHISPER_MODEL, 'onnx-community/whisper-base')
    const whisperEnabled = useLocalStorage(SK_WHISPER_ENABLED, true)
    const whisperQuantization = useLocalStorage(SK_WHISPER_QUANTIZATION, 'q8')
    const whisperLanguage = useLocalStorage(SK_WHISPER_LANGUAGE, 'english')
    const whisperMicDeviceId = useLocalStorage(SK_WHISPER_MIC_DEVICE, '')

    // Apply theme to <html> element
    watch(theme, (val) => {
        document.documentElement.dataset.theme = val
    }, { immediate: true })

    // Sync all pref changes to Electron's JSON file (single watcher)
    watch(
        [theme, autoExpandSteps, autoExpandToolCalls, generateTitle, titleProviderId, titleModel, enableEntityGraph, entityGraphProviderId, entityGraphModel, toolRouterProviderId, toolRouterModel, memoryRouterProviderId, memoryRouterModel, compactProviderId, compactModel, contextStrategy,
            agentCategories, maCategories, whisperModel, whisperEnabled, whisperQuantization, whisperLanguage, whisperMicDeviceId],
        () => { syncPrefsToElectron() },
        { deep: true },
    )

    function toggleTheme() {
        theme.value = theme.value === 'dark' ? 'light' : 'dark'
    }

    function setTheme(id: ThemeId) {
        theme.value = id
    }

    function toggleAutoExpand() {
        autoExpandSteps.value = !autoExpandSteps.value
    }

    function addAgentCategory(name: string) {
        const trimmed = name.trim()
        if (trimmed && !agentCategories.value.includes(trimmed)) {
            agentCategories.value.push(trimmed)
        }
    }

    function removeAgentCategory(name: string) {
        agentCategories.value = agentCategories.value.filter(c => c !== name)
    }

    function renameAgentCategory(oldName: string, newName: string) {
        const trimmed = newName.trim()
        if (!trimmed || trimmed === oldName) return
        agentCategories.value = agentCategories.value.map(c => c === oldName ? trimmed : c)
    }

    function reorderAgentCategory(fromName: string, toName: string, insertBefore: boolean) {
        const updated = [...agentCategories.value]
        const fromIdx = updated.indexOf(fromName)
        if (fromIdx === -1) return
        updated.splice(fromIdx, 1)
        const toIdx = updated.indexOf(toName)
        if (toIdx === -1) return
        updated.splice(insertBefore ? toIdx : toIdx + 1, 0, fromName)
        agentCategories.value = updated
    }

    function addMACategory(name: string) {
        const trimmed = name.trim()
        if (trimmed && !maCategories.value.includes(trimmed)) {
            maCategories.value.push(trimmed)
        }
    }

    function removeMACategory(name: string) {
        maCategories.value = maCategories.value.filter(c => c !== name)
    }

    return {
        theme, autoExpandSteps, autoExpandToolCalls, generateTitle, titleProviderId, titleModel, enableEntityGraph, entityGraphProviderId, entityGraphModel, toolRouterProviderId, toolRouterModel, memoryRouterProviderId, memoryRouterModel, compactProviderId, compactModel, sidebarCollapsed,
        contextStrategy,
        agentCategories, maCategories,
        whisperModel, whisperEnabled, whisperQuantization, whisperLanguage, whisperMicDeviceId,
        toggleTheme, setTheme, toggleAutoExpand,
        addAgentCategory, removeAgentCategory, renameAgentCategory, reorderAgentCategory,
        addMACategory, removeMACategory,
    }
})

if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(usePreferencesStore, import.meta.hot))
}
