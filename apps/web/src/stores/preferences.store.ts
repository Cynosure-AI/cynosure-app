import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref, watch } from 'vue'
import { syncPrefsToElectron } from '@/utils/electron-prefs'

function loadJsonArray(key: string): string[] {
    try {
        const raw = localStorage.getItem(key)
        if (raw) return JSON.parse(raw)
    } catch { /* ignore */ }
    return []
}

export type ThemeId = 'dark' | 'light' | 'arasaka' | 'midnight-purple' | 'cyberpunk'

export type ContextStrategy = 'sliding-window' | 'truncate-middle' | 'none'

export const usePreferencesStore = defineStore('preferences', () => {
    const theme = ref<ThemeId>(
        (localStorage.getItem('oa-theme') as ThemeId) || 'dark'
    )
    const autoExpandSteps = ref(localStorage.getItem('oa-auto-expand') === 'true')
    const autoExpandToolCalls = ref(localStorage.getItem('oa-auto-expand-tools') === 'true')
    const generateTitle = ref(localStorage.getItem('oa-generate-title') !== 'false')
    const sidebarCollapsed = ref(false)
    const contextStrategy = ref<ContextStrategy>(
        (localStorage.getItem('oa-context-strategy') as ContextStrategy) || 'sliding-window'
    )

    const agentCategories = ref<string[]>(loadJsonArray('oa-agent-categories'))
    const maCategories = ref<string[]>(loadJsonArray('oa-ma-categories'))

    const whisperModel = ref(localStorage.getItem('oa-whisper-model') || 'onnx-community/whisper-base')
    const whisperEnabled = ref(localStorage.getItem('oa-whisper-enabled') !== 'false')
    const whisperQuantization = ref(localStorage.getItem('oa-whisper-quantization') || 'q8')
    const whisperLanguage = ref(localStorage.getItem('oa-whisper-language') || 'english')

    watch(
        theme,
        (val) => {
            localStorage.setItem('oa-theme', val)
            document.documentElement.dataset.theme = val
            syncPrefsToElectron()
        },
        { immediate: true }
    )

    watch(autoExpandSteps, (val) => {
        localStorage.setItem('oa-auto-expand', String(val))
        syncPrefsToElectron()
    })

    watch(autoExpandToolCalls, (val) => {
        localStorage.setItem('oa-auto-expand-tools', String(val))
        syncPrefsToElectron()
    })

    watch(generateTitle, (val) => {
        localStorage.setItem('oa-generate-title', String(val))
        syncPrefsToElectron()
    })

    watch(contextStrategy, (val) => {
        localStorage.setItem('oa-context-strategy', val)
        syncPrefsToElectron()
    })

    watch(agentCategories, (val) => {
        localStorage.setItem('oa-agent-categories', JSON.stringify(val))
        syncPrefsToElectron()
    }, { deep: true })

    watch(maCategories, (val) => {
        localStorage.setItem('oa-ma-categories', JSON.stringify(val))
        syncPrefsToElectron()
    }, { deep: true })

    watch(whisperModel, (val) => {
        localStorage.setItem('oa-whisper-model', val)
        syncPrefsToElectron()
    })

    watch(whisperEnabled, (val) => {
        localStorage.setItem('oa-whisper-enabled', String(val))
        syncPrefsToElectron()
    })

    watch(whisperQuantization, (val) => {
        localStorage.setItem('oa-whisper-quantization', val)
        syncPrefsToElectron()
    })

    watch(whisperLanguage, (val) => {
        localStorage.setItem('oa-whisper-language', val)
        syncPrefsToElectron()
    })

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
        theme, autoExpandSteps, autoExpandToolCalls, generateTitle, sidebarCollapsed,
        contextStrategy,
        agentCategories, maCategories,
        whisperModel, whisperEnabled, whisperQuantization, whisperLanguage,
        toggleTheme, setTheme, toggleAutoExpand,
        addAgentCategory, removeAgentCategory, renameAgentCategory,
        addMACategory, removeMACategory,
    }
})

if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(usePreferencesStore, import.meta.hot))
}
