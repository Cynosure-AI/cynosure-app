import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref, watch } from 'vue'
import { useLocalStorage } from '@vueuse/core'
import { syncPrefsToElectron } from '@/utils/electron-prefs'
import { api } from '@/api/client'
import type { ChatRunSettings, ContextStrategy } from '@shared/types'
import {
    SK_THEME, SK_AUTO_EXPAND, SK_GENERATE_TITLE, SK_QUICK_RESPONSES, SK_TITLE_PROVIDER, SK_TITLE_MODEL,
    SK_CONTEXT_STRATEGY, SK_INLINE_ATTACHMENT_TEXT_LIMIT, SK_COMPACT_PROVIDER, SK_COMPACT_MODEL,
    SK_AGENT_CATEGORIES, SK_MA_CATEGORIES,
    SK_RECENT_CHAT_FILTER,
    SK_WHISPER_MODEL, SK_WHISPER_ENABLED, SK_WHISPER_QUANTIZATION, SK_WHISPER_LANGUAGE, SK_WHISPER_MIC_DEVICE,
    SK_VOICE_TRANSCRIPTION_MODE, SK_REMOTE_TRANSCRIPTION_PROVIDER, SK_REMOTE_TRANSCRIPTION_MODEL,
} from '@/utils/storage-keys'

export type ThemeId = 'dark' | 'light' | 'virtualboy' | 'crimson' | 'cyberpunk' | 'emerald' | 'industrial' | 'monochrome'
const THEME_IDS = new Set<ThemeId>(['dark', 'light', 'virtualboy', 'crimson', 'cyberpunk', 'emerald', 'industrial', 'monochrome'])

export type { ContextStrategy }
export type VoiceTranscriptionMode = 'local' | 'remote'
export type RecentChatFilter = 'all' | 'free' | 'agents' | 'cron' | 'channel'

export const usePreferencesStore = defineStore('preferences', () => {
    const userName = ref('')
    const userAvatarUrl = ref<string | null>(null)
    const userSettingsLoaded = ref(false)
    const userSettingsSaving = ref(false)
    const theme = useLocalStorage<ThemeId>(SK_THEME, 'crimson')
    if (!THEME_IDS.has(theme.value)) theme.value = 'crimson'
    const autoExpandSteps = useLocalStorage(SK_AUTO_EXPAND, false)
    const quickResponses = useLocalStorage(SK_QUICK_RESPONSES, false)
    const sidebarCollapsed = ref(false)
    const recentChatFilter = useLocalStorage<RecentChatFilter[]>(SK_RECENT_CHAT_FILTER, ['all'])
    // Migrate the former single-select preference and discard malformed values.
    const storedRecentChatFilter = recentChatFilter.value as unknown
    const validRecentChatFilters = new Set<RecentChatFilter>(['all', 'free', 'agents', 'cron', 'channel'])
    if (!Array.isArray(storedRecentChatFilter)) {
        recentChatFilter.value = storedRecentChatFilter === 'agent' ? ['agents'] : ['all']
    } else {
        const valid = storedRecentChatFilter.filter((value): value is RecentChatFilter => validRecentChatFilters.has(value as RecentChatFilter))
        recentChatFilter.value = valid.includes('all') || valid.length === 0 ? ['all'] : [...new Set(valid)]
    }

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

    // Apply theme to <html> element
    watch(theme, (val) => {
        document.documentElement.dataset.theme = val
    }, { immediate: true })

    // Sync all pref changes to Electron's JSON file (single watcher)
    watch(
        [theme, autoExpandSteps, quickResponses, recentChatFilter,
            agentCategories, maCategories, whisperModel, whisperEnabled, whisperQuantization, whisperLanguage, whisperMicDeviceId,
            voiceTranscriptionMode, remoteTranscriptionProviderId, remoteTranscriptionModel],
        () => { syncPrefsToElectron() },
        { deep: true },
    )

    function toggleTheme() {
        theme.value = theme.value === 'light' ? 'crimson' : 'light'
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

    /**
     * Chat run settings (titles, context strategy, summarization model) now
     * live on the server. Copy choices made in this browser once, then drop them.
     */
    async function migrateLegacyChatRunSettings() {
        const read = (key: string) => localStorage.getItem(key)
        const legacyKeys = [SK_GENERATE_TITLE, SK_TITLE_PROVIDER, SK_TITLE_MODEL, SK_CONTEXT_STRATEGY,
            SK_INLINE_ATTACHMENT_TEXT_LIMIT, SK_COMPACT_PROVIDER, SK_COMPACT_MODEL]
        if (!legacyKeys.some((key) => read(key) !== null)) return

        const legacy: Partial<ChatRunSettings> = {}
        if (read(SK_GENERATE_TITLE) === 'false') legacy.generateTitle = false
        if (read(SK_TITLE_PROVIDER)) legacy.titleProviderId = read(SK_TITLE_PROVIDER)!
        if (read(SK_TITLE_MODEL)) legacy.titleModel = read(SK_TITLE_MODEL)!
        if (read(SK_COMPACT_PROVIDER)) legacy.compactProviderId = read(SK_COMPACT_PROVIDER)!
        if (read(SK_COMPACT_MODEL)) legacy.compactModel = read(SK_COMPACT_MODEL)!
        // Sliding window was the stored default, so only a different choice was deliberate.
        const strategy = read(SK_CONTEXT_STRATEGY)
        if (strategy && strategy !== 'sliding-window') legacy.contextStrategy = strategy as ContextStrategy
        try {
            const { saved } = await api.chat.getRunSettings()
            if (!saved && Object.keys(legacy).length) await api.chat.updateRunSettings(legacy)
            legacyKeys.forEach((key) => localStorage.removeItem(key))
            syncPrefsToElectron()
        } catch {
            // Keep the browser values and retry on the next start.
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
        migrateLegacyChatRunSettings,
        theme, autoExpandSteps, quickResponses, sidebarCollapsed, recentChatFilter,
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
