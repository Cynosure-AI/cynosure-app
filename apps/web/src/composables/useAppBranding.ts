import { computed } from 'vue'
import { usePreferencesStore } from '../stores/preferences.store'

import cynosureLogoDark from '../assets/img/app-logo/cynosure-logo-black.png' //Light mode logo
import cynosureLogoLight from '../assets/img/app-logo/cynosure-logo-white.png' //Dark mode logo
import cynosureLogoTextDark from '../assets/img/app-logo/cynosure-logo-text-red.png' //White mode logo
import cynosureLogoTextLight from '../assets/img/app-logo/cynosure-logo-text-red.png' //Dark mode logo

export function useAppBranding() {
    const prefs = usePreferencesStore()
    const isLightTheme = computed(() => prefs.theme === 'light')

    const logoIconUrl = computed(() => isLightTheme.value ? cynosureLogoLight : cynosureLogoDark)
    const logoTextUrl = computed(() => isLightTheme.value ? cynosureLogoTextDark : cynosureLogoTextLight)

    return {
        logoIconUrl,
        logoTextUrl,
    }
}
