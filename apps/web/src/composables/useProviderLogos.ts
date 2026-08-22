import { usePreferencesStore } from '../stores/preferences.store'

import openaiLogo from '../assets/img/provider-logos/openai.png'
import openaiLogoDark from '../assets/img/provider-logos/openai-dark.png'
import anthropicLogo from '../assets/img/provider-logos/anthropic.png'
import anthropicLogoDark from '../assets/img/provider-logos/anthropic-dark.png'
import geminiLogo from '../assets/img/provider-logos/google-gemini.png'
import lmstudioLogo from '../assets/img/provider-logos/lmstudio.png'
import grokLogo from '../assets/img/provider-logos/grok.png'
import grokLogoDark from '../assets/img/provider-logos/grok-dark.png'
import ollamaLogo from '../assets/img/provider-logos/ollama.png'
import ollamaLogoDark from '../assets/img/provider-logos/ollama-dark.png'
import openrouterLogo from '../assets/img/provider-logos/openrouter.png'
import openrouterLogoDark from '../assets/img/provider-logos/openrouter-dark.png'
import requestyLogo from '../assets/img/provider-logos/requesty.png'
import groqLogo from '../assets/img/provider-logos/groq.png'
import mistralLogo from '../assets/img/provider-logos/mistral.png'

const providerLogos: Record<string, { light: string; dark: string }> = {
    openai: { light: openaiLogo, dark: openaiLogoDark },
    anthropic: { light: anthropicLogo, dark: anthropicLogoDark },
    google: { light: geminiLogo, dark: geminiLogo },
    lmstudio: { light: lmstudioLogo, dark: lmstudioLogo },
    grok: { light: grokLogo, dark: grokLogoDark },
    ollama: { light: ollamaLogo, dark: ollamaLogoDark },
    openrouter: { light: openrouterLogo, dark: openrouterLogoDark },
    requesty: { light: requestyLogo, dark: requestyLogo },
    groq: { light: groqLogo, dark: groqLogo },
    mistral: { light: mistralLogo, dark: mistralLogo },
}

export function useProviderLogos() {
    const prefs = usePreferencesStore()

    function logoUrl(type: string): string | null {
        const logos = providerLogos[type]
        if (!logos) return null
        return prefs.theme === 'light' ? logos.light : logos.dark
    }

    return { providerLogos, logoUrl }
}
