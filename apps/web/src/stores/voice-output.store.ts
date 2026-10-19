import { defineStore, acceptHMRUpdate } from 'pinia'
import { computed, ref } from 'vue'
import type { PiperVoice, PiperVoiceDownload, VoiceOutputSettings } from '@shared/types'
import { api } from '../api/client'

/** Cyno's voice: server-side settings, installed voices and downloads. */
export const useVoiceOutputStore = defineStore('voice-output', () => {
    const settings = ref<VoiceOutputSettings | null>(null)
    const voices = ref<PiperVoice[]>([])
    const downloads = ref<Record<string, PiperVoiceDownload>>({})
    const catalogError = ref('')
    const voicesLoading = ref(false)
    let unsubscribeProgress: (() => void) | null = null

    const installedVoices = computed(() => voices.value.filter((voice) => voice.installed))
    const selectedVoice = computed(() => voices.value.find((voice) => voice.id === settings.value?.voiceId) ?? null)
    /** Speaker buttons and auto-read appear once a voice is chosen. */
    const canSpeak = computed(() => Boolean(settings.value?.enabled && settings.value.voiceId))

    async function load(): Promise<void> {
        try {
            settings.value = await api.tts.getSettings()
        } catch {
            // Non-critical during startup; the app works without a voice.
        }
        unsubscribeProgress ??= api.tts.onDownloadProgress(onDownloadProgress)
    }

    async function loadVoices(): Promise<void> {
        voicesLoading.value = true
        try {
            const list = await api.tts.voices()
            voices.value = list.voices
            catalogError.value = list.catalogError ?? ''
            downloads.value = Object.fromEntries(list.downloads.map((download) => [download.voiceId, download]))
        } finally {
            voicesLoading.value = false
        }
    }

    async function update(changes: Partial<VoiceOutputSettings>): Promise<void> {
        const previous = settings.value
        if (previous) settings.value = { ...previous, ...changes }
        try {
            settings.value = await api.tts.updateSettings(changes)
        } catch (err) {
            settings.value = previous
            throw err
        }
    }

    function onDownloadProgress(progress: PiperVoiceDownload): void {
        downloads.value = { ...downloads.value, [progress.voiceId]: progress }
        if (progress.status !== 'done') return
        const rest = { ...downloads.value }
        delete rest[progress.voiceId]
        downloads.value = rest
        voices.value = voices.value.map((voice) => voice.id === progress.voiceId ? { ...voice, installed: true } : voice)
        // The first voice becomes Cyno's voice without another click.
        if (settings.value && !settings.value.voiceId) void update({ voiceId: progress.voiceId, speakerId: 0 })
    }

    async function download(voiceId: string): Promise<void> {
        const progress = await api.tts.download(voiceId)
        downloads.value = { ...downloads.value, [voiceId]: progress }
    }

    async function remove(voiceId: string): Promise<void> {
        await api.tts.remove(voiceId)
        voices.value = voices.value.map((voice) => voice.id === voiceId ? { ...voice, installed: false } : voice)
        if (settings.value?.voiceId === voiceId) settings.value = { ...settings.value, voiceId: '', speakerId: 0 }
    }

    return {
        settings, voices, downloads, catalogError, voicesLoading, installedVoices, selectedVoice, canSpeak,
        load, loadVoices, update, download, remove,
    }
})

if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(useVoiceOutputStore, import.meta.hot))
}
