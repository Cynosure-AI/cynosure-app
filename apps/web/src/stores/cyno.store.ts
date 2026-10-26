import { defineStore, acceptHMRUpdate } from 'pinia'
import { computed, ref } from 'vue'
import type { CynoProfile, CynoProfileView } from '@shared/types'
import { api } from '../api/client'
import { useAppBranding } from '../composables/useAppBranding'
import { displayedIconUrl } from '../utils/avatar'
import { SK_FREE_CHAT_MODEL, SK_FREE_CHAT_PROVIDER } from '../utils/storage-keys'
import cynosureLogoRed from '../assets/img/app-logo/cynosure-logo-red.png'

export type { CynoProfile, CynoProfileView }

export type CynoProfileChanges = Partial<Omit<CynoProfile, 'updatedAt'>> & { imageUrl?: string | null }

/** Cyno, the default assistant: its server-side profile and how to show it. */
export const useCynoStore = defineStore('cyno', () => {
    const profile = ref<CynoProfileView | null>(null)
    const defaults = ref<CynoProfileView | null>(null)
    let loading: Promise<void> | null = null

    const name = computed(() => profile.value?.name || 'Cyno')
    /** Cyno's retained image, the default one until something is uploaded. */
    const imageUrl = computed(() => profile.value?.iconUrl || cynosureLogoRed)
    const avatarSource = computed(() => profile.value?.avatarSource ?? 'generated')
    /** Cyno's image when it is the chosen face; null shows the generated avatar. Same meaning as an agent's iconUrl. */
    const iconUrl = computed(() => displayedIconUrl(avatarSource.value, imageUrl.value))
    /** For branding spots: Cyno's chosen image, or the theme's app logo. */
    const brandIconUrl = computed(() => iconUrl.value || useAppBranding().logoIconUrl.value)
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

    /** Accepts `imageUrl` like an agent update; the profile stores that image as `iconUrl`. */
    async function update(changes: CynoProfileChanges): Promise<CynoProfileView> {
        const { imageUrl: image, ...rest } = changes
        let payload: Partial<Omit<CynoProfile, 'updatedAt'>> = image === undefined ? rest : { ...rest, iconUrl: image }
        if (payload.avatarSource === 'image' && payload.iconUrl === undefined && !profile.value?.iconUrl) {
            // Persist the built-in image in the same format as uploads, so every
            // client and server-rendered job sees it. Load its data only on selection.
            const { default: iconUrl } = await import('../assets/img/app-logo/cynosure-logo-red.png?inline')
            payload = { ...payload, iconUrl }
        }
        const next = await api.cyno.update(payload)
        profile.value = next
        return next
    }

    return { profile, defaults, name, iconUrl, imageUrl, avatarSource, brandIconUrl, avatar, load, update }
})

if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(useCynoStore, import.meta.hot))
}
