import { defineStore, acceptHMRUpdate } from 'pinia'
import { computed, ref } from 'vue'
import type { CynoProfile, CynoProfileView } from '@shared/types'
import { api } from '../api/client'
import { useAppBranding } from '../composables/useAppBranding'
import { SK_FREE_CHAT_MODEL, SK_FREE_CHAT_PROVIDER } from '../utils/storage-keys'

export type { CynoProfile, CynoProfileView }

/** Cyno, the default assistant: its server-side profile and how to show it. */
export const useCynoStore = defineStore('cyno', () => {
    const profile = ref<CynoProfileView | null>(null)
    const defaults = ref<CynoProfileView | null>(null)
    let loading: Promise<void> | null = null

    const name = computed(() => profile.value?.name || 'Cyno')
    /** Cyno's image when it is the chosen face; null shows the generated avatar. */
    const displayIconUrl = computed(() => profile.value?.avatarSource === 'image' ? profile.value.iconUrl : null)
    /** For branding spots: Cyno's chosen image, or the theme's app logo. */
    const iconUrl = computed(() => displayIconUrl.value || useAppBranding().logoIconUrl.value)
    const avatar = computed(() => profile.value?.avatar ?? null)

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

    async function update(changes: Partial<Omit<CynoProfile, 'updatedAt'>>): Promise<CynoProfileView> {
        const next = await api.cyno.update(changes)
        profile.value = next
        return next
    }

    return { profile, defaults, name, iconUrl, displayIconUrl, avatar, load, update }
})

if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(useCynoStore, import.meta.hot))
}
