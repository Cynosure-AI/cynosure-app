import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref, watch } from 'vue'
import { useLocalStorage } from '@vueuse/core'
import { syncPrefsToElectron } from '@/utils/electron-prefs'
import { api } from '@/api/client'
import {
    SK_THEME, SK_AUTO_EXPAND, SK_AUTO_EXPAND_TOOLS, SK_DEBUG_MODE, SK_GENERATE_TITLE, SK_TITLE_PROVIDER, SK_TITLE_MODEL,
    SK_KNOWLEDGE_PROVIDER, SK_KNOWLEDGE_MODEL,
    SK_AUTO_ROUTER_PROVIDER, SK_AUTO_ROUTER_MODEL, SK_LEGACY_SKILL_ROUTER_PROVIDER, SK_LEGACY_SKILL_ROUTER_MODEL,
    SK_CONTEXT_STRATEGY, SK_INLINE_ATTACHMENT_TEXT_LIMIT, SK_COMPACT_PROVIDER, SK_COMPACT_MODEL,
    SK_AGENT_CATEGORIES, SK_MA_CATEGORIES,
    SK_RECENT_CHAT_FILTER,
    SK_WHISPER_MODEL, SK_WHISPER_ENABLED, SK_WHISPER_QUANTIZATION, SK_WHISPER_LANGUAGE, SK_WHISPER_MIC_DEVICE,
    SK_VOICE_TRANSCRIPTION_MODE, SK_REMOTE_TRANSCRIPTION_PROVIDER, SK_REMOTE_TRANSCRIPTION_MODEL,
} from '@/utils/storage-keys'

export type ThemeId = 'dark' | 'light' | 'arasaka' | 'galaxy' | 'cyberpunk' | 'matrix' | 'sakura' | 'industrial' | 'arctic' | 'monochrome'

export type ContextStrategy = 'sliding-window' | 'truncate-middle' | 'compact' | 'none'
export type VoiceTranscriptionMode = 'local' | 'remote'
export type RecentChatFilter = 'all' | 'agent'

export const usePreferencesStore = defineStore('preferences', () => {
    const userName = ref('')
    const userAvatarUrl = ref<string | null>(null)
    const userSettingsLoaded = ref(false)
    const userSettingsSaving = ref(false)
    const theme = useLocalStorage<ThemeId>(SK_THEME, 'dark')
    const autoExpandSteps = useLocalStorage(SK_AUTO_EXPAND, false)
    const autoExpandToolCalls = useLocalStorage(SK_AUTO_EXPAND_TOOLS, false)
    const debugMode = useLocalStorage(SK_DEBUG_MODE, false)
    const generateTitle = useLocalStorage(SK_GENERATE_TITLE, true)
    const titleProviderId = useLocalStorage(SK_TITLE_PROVIDER, '')
    const titleModel = useLocalStorage(SK_TITLE_MODEL, '')
    const knowledgeProviderId = useLocalStorage(SK_KNOWLEDGE_PROVIDER, '')
    const knowledgeModel = useLocalStorage(SK_KNOWLEDGE_MODEL, '')
    const autoRouterProviderId = useLocalStorage(SK_AUTO_ROUTER_PROVIDER, '')
    const autoRouterModel = useLocalStorage(SK_AUTO_ROUTER_MODEL, '')
    const compactProviderId = useLocalStorage(SK_COMPACT_PROVIDER, '')
    const compactModel = useLocalStorage(SK_COMPACT_MODEL, '')
    const sidebarCollapsed = ref(false)
    const recentChatFilter = useLocalStorage<RecentChatFilter>(SK_RECENT_CHAT_FILTER, 'all')
    const contextStrategy = useLocalStorage<ContextStrategy>(SK_CONTEXT_STRATEGY, 'sliding-window')
    const inlineAttachmentTextLimit = useLocalStorage(SK_INLINE_ATTACHMENT_TEXT_LIMIT, 24_000)

    const agentCategories = useLocalStorage<string[]>(SK_AGENT_CATEGORIES, [])
    const maCategories = useLocalStorage<string[]>(SK_MA_CATEGORIES, [])

    const whisperModel = useLocalStorage(SK_WHISPER_MODEL, 'onnx-community/whisper-base')
    const whisperEnabled = useLocalStorage(SK_WHISPER_ENABLED, true)
    const whisperQuantization = useLocalStorage(SK_WHISPER_QUANTIZATION, 'q8')
    const whisperLanguage = useLocalStorage(SK_WHISPER_LANGUAGE, 'english')
    const whisperMicDeviceId = useLocalStorage(SK_WHISPER_MIC_DEVICE, '')
    const voiceTranscriptionMode = useLocalStorage<VoiceTranscriptionMode>(SK_VOICE_TRANSCRIPTION_MODE, 'local')
    const remoteTranscriptionProviderId = useLocalStorage(SK_REMOTE_TRANSCRIPTION_PROVIDER, '')
    const remoteTranscriptionModel = useLocalStorage(SK_REMOTE_TRANSCRIPTION_MODEL, '')

    if (!autoRouterProviderId.value) {
        autoRouterProviderId.value = localStorage.getItem(SK_LEGACY_SKILL_ROUTER_PROVIDER) || ''
    }
    if (!autoRouterModel.value) {
        autoRouterModel.value = localStorage.getItem(SK_LEGACY_SKILL_ROUTER_MODEL) || ''
    }

    // Apply theme to <html> element
    watch(theme, (val) => {
        document.documentElement.dataset.theme = val
    }, { immediate: true })

    // Sync all pref changes to Electron's JSON file (single watcher)
    watch(
        [theme, autoExpandSteps, autoExpandToolCalls, debugMode, generateTitle, titleProviderId, titleModel, knowledgeProviderId, knowledgeModel, autoRouterProviderId, autoRouterModel, compactProviderId, compactModel, contextStrategy, inlineAttachmentTextLimit, recentChatFilter,
            agentCategories, maCategories, whisperModel, whisperEnabled, whisperQuantization, whisperLanguage, whisperMicDeviceId,
            voiceTranscriptionMode, remoteTranscriptionProviderId, remoteTranscriptionModel],
        () => { syncPrefsToElectron() },
        { deep: true },
    )

    function toggleTheme() {
        theme.value = theme.value === 'dark' ? 'light' : 'dark'
    }

    async function loadUserSettings() {
        try {
            const settings = await api.userSettings.get()
            userName.value = settings.name
            userAvatarUrl.value = settings.avatarUrl
        } catch {
            // Non-critical during startup; reconnect will retry with the other stores.
        } finally {
            userSettingsLoaded.value = true
        }
    }

    async function saveUserProfile() {
        userSettingsSaving.value = true
        try {
            const settings = await api.userSettings.update({
                name: userName.value,
                avatarUrl: userAvatarUrl.value,
            })
            userName.value = settings.name
            userAvatarUrl.value = settings.avatarUrl
        } finally {
            userSettingsSaving.value = false
        }
    }

    const saveUserName = saveUserProfile

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
        userName, userAvatarUrl, userSettingsLoaded, userSettingsSaving, loadUserSettings, saveUserProfile, saveUserName,
        theme, autoExpandSteps, autoExpandToolCalls, debugMode, generateTitle, titleProviderId, titleModel, knowledgeProviderId, knowledgeModel, autoRouterProviderId, autoRouterModel, compactProviderId, compactModel, sidebarCollapsed, recentChatFilter,
        contextStrategy, inlineAttachmentTextLimit,
        agentCategories, maCategories,
        whisperModel, whisperEnabled, whisperQuantization, whisperLanguage, whisperMicDeviceId,
        voiceTranscriptionMode, remoteTranscriptionProviderId, remoteTranscriptionModel,
        toggleTheme, setTheme, toggleAutoExpand,
        addAgentCategory, removeAgentCategory, renameAgentCategory, reorderAgentCategory,
        addMACategory, removeMACategory,
    }
})

if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(usePreferencesStore, import.meta.hot))
}
