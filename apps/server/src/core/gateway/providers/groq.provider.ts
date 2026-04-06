import { OpenRouterProvider } from './openrouter.provider.js'
import type { LLMProviderConfig } from './base.provider.js'

/**
 * Groq provider — uses the OpenAI-compatible Chat Completions API
 * at https://api.groq.com/openai/v1.
 *
 * Groq offers extremely fast inference on open-source models
 * (Llama, Mixtral, Gemma, etc.) with a generous free tier.
 */
export class GroqProvider extends OpenRouterProvider {
    constructor(config: LLMProviderConfig) {
        super({
            ...config,
            baseUrl: config.baseUrl || 'https://api.groq.com/openai/v1'
        })
    }

    async listModels(_type?: 'llm' | 'embedding'): Promise<string[]> {
        // Groq uses the standard OpenAI models endpoint
        const baseUrl = (
            this.config.baseUrl || 'https://api.groq.com/openai/v1'
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
                this.config.baseUrl || 'https://api.groq.com/openai/v1'
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
