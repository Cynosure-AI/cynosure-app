import { OpenRouterProvider } from './openrouter.provider.js'
import type { LLMProviderConfig } from './base.provider.js'

/**
 * Mistral provider — uses the OpenAI-compatible Chat Completions API
 * at https://api.mistral.ai/v1.
 */
export class MistralProvider extends OpenRouterProvider {
    constructor(config: LLMProviderConfig) {
        super({
            ...config,
            baseUrl: config.baseUrl || 'https://api.mistral.ai/v1'
        })
    }

    async listModels(_type?: 'llm' | 'embedding'): Promise<string[]> {
        const baseUrl = (
            this.config.baseUrl || 'https://api.mistral.ai/v1'
        ).replace(/\/+$/, '')

        const res = await fetch(`${baseUrl}/models`, {
            headers: this.config.apiKey
                ? { Authorization: `Bearer ${this.config.apiKey}` }
                : {}
        })

        if (!res.ok) {
            return []
        }

        const data = (await res.json()) as {
            data: Array<{ id: string }>
        }
        return data.data.map((m) => m.id).sort()
    }

    async testConnection(): Promise<boolean> {
        try {
            const baseUrl = (
                this.config.baseUrl || 'https://api.mistral.ai/v1'
            ).replace(/\/+$/, '')

            const res = await fetch(`${baseUrl}/models`, {
                headers: this.config.apiKey
                    ? { Authorization: `Bearer ${this.config.apiKey}` }
                    : {}
            })
            return res.ok
        } catch {
            return false
        }
    }
}
