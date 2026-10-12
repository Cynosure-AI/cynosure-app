import { computed } from 'vue'
import { usePreferencesStore } from '../stores/preferences.store'

import cynosureLogoRed from '../assets/img/app-logo/cynosure-logo-red.png'
import cynosureLogoBlue from '../assets/img/app-logo/cynosure-logo-blue.png'
import cynosureLogoYellow from '../assets/img/app-logo/cynosure-logo-yellow.png'
import cynosureLogoGreen from '../assets/img/app-logo/cynosure-logo-green.png'

import cynosureLogoTextRed from '../assets/img/app-logo/cynosure-logo-text-red.png'
import cynosureLogoTextBlue from '../assets/img/app-logo/cynosure-logo-text-blue.png'
import cynosureLogoTextYellow from '../assets/img/app-logo/cynosure-logo-text-yellow.png'
import cynosureLogoTextGreen from '../assets/img/app-logo/cynosure-logo-text-green.png'

export function useAppBranding() {
    const prefs = usePreferencesStore()

    const logoIconUrl = computed(() => {
        switch (prefs.theme) {
            case 'light': return cynosureLogoBlue
            case 'cyberpunk': return cynosureLogoYellow
            case 'emerald': return cynosureLogoGreen
            case 'industrial': return cynosureLogoYellow
            case 'monochrome': return cynosureLogoRed
            case 'dark': return cynosureLogoBlue
            case 'blackwall': return cynosureLogoRed
            case 'crimson': return cynosureLogoRed
            default: return cynosureLogoRed
        }
    })

    const logoTextUrl = computed(() => {
        switch (prefs.theme) {
            case 'light': return cynosureLogoTextBlue
            case 'cyberpunk': return cynosureLogoTextYellow
            case 'emerald': return cynosureLogoTextGreen
            case 'industrial': return cynosureLogoTextYellow
            case 'monochrome': return cynosureLogoTextRed
            case 'dark': return cynosureLogoTextBlue
            case 'blackwall': return cynosureLogoTextRed
            case 'crimson': return cynosureLogoTextRed
            default: return cynosureLogoTextRed
        }
    })

    return {
        logoIconUrl,
        logoTextUrl,
    }
}
