import { defineStore, acceptHMRUpdate } from 'pinia'
import { computed, ref } from 'vue'
import type { CynoProfile } from '@shared/types'
import { api } from '../api/client'
import { useAppBranding } from '../composables/useAppBranding'
import { SK_FREE_CHAT_MODEL, SK_FREE_CHAT_PROVIDER } from '../utils/storage-keys'

export type { CynoProfile }

/** Cyno, the default assistant: its server-side profile and how to show it. */
export const useCynoStore = defineStore('cyno', () => {
    const profile = ref<CynoProfile | null>(null)
    const defaults = ref<CynoProfile | null>(null)
    let loading: Promise<void> | null = null

    const name = computed(() => profile.value?.name || 'Cyno')
    /** Cyno's own icon, or the theme's app logo. */
    const iconUrl = computed(() => profile.value?.iconUrl || useAppBranding().logoIconUrl.value)

    function load(): Promise<void> {
        loading ??= Promise.all([api.cyno.get(), api.cyno.defaults()])
            .then(async ([current, factory]) => {
                profile.value = current
                defaults.value = factory
                await adoptLegacyModelChoice()
            })
            .finally(() => { loading = null })
        return loading
    }

    /** Free Chat used to keep its model in this browser; move it to Cyno once. */
    async function adoptLegacyModelChoice(): Promise<void> {
        try {
            const model = localStorage.getItem(SK_FREE_CHAT_MODEL) || ''
            const providerId = localStorage.getItem(SK_FREE_CHAT_PROVIDER) || ''
            if (!model && !providerId) return
            if (!profile.value?.model && !profile.value?.providerId) await update({ model, providerId })
            localStorage.removeItem(SK_FREE_CHAT_MODEL)
            localStorage.removeItem(SK_FREE_CHAT_PROVIDER)
        } catch {
            // Storage may be unavailable; the profile keeps the app default model.
        }
    }

    async function update(changes: Partial<Omit<CynoProfile, 'updatedAt'>>): Promise<CynoProfile> {
        const next = await api.cyno.update(changes)
        profile.value = next
        return next
    }

    return { profile, defaults, name, iconUrl, load, update }
})

if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(useCynoStore, import.meta.hot))
}
