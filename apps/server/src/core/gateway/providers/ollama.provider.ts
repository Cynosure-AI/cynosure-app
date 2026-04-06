import { OpenAIProvider } from './openai.provider.js'
import type { LLMProviderConfig } from './base.provider.js'

/**
 * Ollama provider — uses the OpenAI-compatible API.
 * Defaults to http://localhost:11434/v1
 */
export class OllamaProvider extends OpenAIProvider {
    constructor(config: LLMProviderConfig) {
        super({
            ...config,
            baseUrl: config.baseUrl || 'http://localhost:11434/v1',
            apiKey: config.apiKey || 'ollama' // Ollama doesn't require a real key
        })
    }

    /**
     * Use Ollama's native REST API to list models.
     * Endpoint: GET {host}/api/tags
     */
    async listModels(type?: 'llm' | 'embedding'): Promise<string[]> {
        const base = (this.config.baseUrl || 'http://localhost:11434/v1').replace(/\/v1\/?$/, '')
        const url = `${base}/api/tags`

        try {
            const res = await fetch(url)
            if (!res.ok) {
                return super.listModels(type)
            }
            const data = (await res.json()) as { models: { name: string }[] }
            let models = data.models.map((m) => m.name)
            if (type) {
                const embeddingPattern = /embed|clip/i
                models = type === 'embedding'
                    ? models.filter((m) => embeddingPattern.test(m))
                    : models.filter((m) => !embeddingPattern.test(m))
            }
            return models.sort()
        } catch {
            return super.listModels(type)
        }
    }
}
