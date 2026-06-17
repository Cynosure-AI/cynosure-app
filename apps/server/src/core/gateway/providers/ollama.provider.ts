import { OpenAIProvider } from './openai.provider.js'
import type { LLMProviderConfig, ModelInfo, ModelListType } from './base.provider.js'

/**
 * Ollama provider — uses the OpenAI-compatible API.
 * Defaults to http://localhost:11434/v1
 */
export class OllamaProvider extends OpenAIProvider {
    protected override get defaultBaseUrl(): string { return 'http://localhost:11434/v1' }
    protected override get allowsCustomBaseUrl(): boolean { return true }

    constructor(config: LLMProviderConfig) {
        super({
            ...config,
            apiKey: config.apiKey || 'ollama' // Ollama doesn't require a real key
        })
    }

    /**
     * Use Ollama's native REST API to list models.
     * Endpoint: GET {host}/api/tags
     */
    async listModels(type?: ModelListType): Promise<string[]> {
        if (type === 'video' || type === 'image') return []
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

    /**
     * Fetch model metadata via Ollama's /api/ps (running models) first,
     * falling back to /api/show.  The /api/ps response contains the actual
     * runtime context_length that Ollama allocated in VRAM, whereas /api/show
     * only reports the Modelfile / architectural value.
     */
    async getModelInfo(modelId: string): Promise<ModelInfo> {
        const base = (this.config.baseUrl || 'http://localhost:11434/v1').replace(/\/v1\/?$/, '')

        try {
            // 1. Check /api/ps for the actually loaded context length
            const psRes = await fetch(`${base}/api/ps`)
            if (psRes.ok) {
                const psData = await psRes.json() as {
                    models?: { name: string; context_length?: number }[]
                }
                const running = psData.models?.find(m => m.name === modelId)
                if (running?.context_length) {
                    return { id: modelId, contextLength: running.context_length }
                }
            }
        } catch { /* model not loaded yet, fall through */ }

        try {
            // 2+3. Fall back to /api/show
            const res = await fetch(`${base}/api/show`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: modelId })
            })
            if (!res.ok) return { id: modelId }

            const data = await res.json() as {
                model_info?: Record<string, unknown>
                parameters?: string
            }

            let contextLength: number | undefined

            if (data.parameters) {
                const match = data.parameters.match(/num_ctx\s+(\d+)/)
                if (match) contextLength = parseInt(match[1], 10)
            }

            if (!contextLength && data.model_info) {
                for (const [key, val] of Object.entries(data.model_info)) {
                    if (/context.?length/i.test(key) && typeof val === 'number') {
                        contextLength = val
                        break
                    }
                }
            }

            return { id: modelId, contextLength }
        } catch {
            return { id: modelId }
        }
    }
}
