import { computed } from 'vue'
import { usePreferencesStore } from '../stores/preferences.store'

import cynosureLogoRed from '../assets/img/app-logo/cynosure-logo-red.png'
import cynosureLogoBlue from '../assets/img/app-logo/cynosure-logo-blue.png'
import cynosureLogoYellow from '../assets/img/app-logo/cynosure-logo-yellow.png'
import cynosureLogoPurple from '../assets/img/app-logo/cynosure-logo-purple.png'

import cynosureLogoTextRed from '../assets/img/app-logo/cynosure-logo-text-red.png'
import cynosureLogoTextBlue from '../assets/img/app-logo/cynosure-logo-text-blue.png'
import cynosureLogoTextYellow from '../assets/img/app-logo/cynosure-logo-text-yellow.png'
import cynosureLogoTextPurple from '../assets/img/app-logo/cynosure-logo-text-purple.png'

export function useAppBranding() {
    const prefs = usePreferencesStore()

    const logoIconUrl = computed(() => {
        switch (prefs.theme) {
            case 'light': return cynosureLogoBlue
            case 'cyberpunk': return cynosureLogoYellow
            case 'midnight-purple': return cynosureLogoPurple
            case 'dark': return cynosureLogoRed
            case 'arasaka': return cynosureLogoRed
            default: return cynosureLogoRed
        }
    })

    const logoTextUrl = computed(() => {
        switch (prefs.theme) {
            case 'light': return cynosureLogoTextBlue
            case 'cyberpunk': return cynosureLogoTextYellow
            case 'midnight-purple': return cynosureLogoTextPurple
            case 'dark': return cynosureLogoTextRed
            case 'arasaka': return cynosureLogoTextRed
            default: return cynosureLogoTextRed
        }
    })

    return {
        logoIconUrl,
        logoTextUrl,
    }
}
