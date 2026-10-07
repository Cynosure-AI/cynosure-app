import { OpenRouterProvider } from './openrouter.provider.js'
import type { ModelInfo, ModelListItem, ModelListType } from './base.provider.js'

interface UnslothModel {
    id: string
    context_length?: number
    max_context_length?: number
}

/** /v1/models does not say what a model is for, so embedding models are recognised by name. */
const EMBEDDING_MODEL_PATTERN = /embed|\bbge\b|\bgte\b|\be5\b/i

/**
 * Unsloth Studio provider — uses the OpenAI-compatible Chat Completions API.
 * Defaults to http://localhost:8888/v1
 *
 * Unlike other local servers, Unsloth Studio requires an API key
 * (`sk-unsloth-…`, created under Settings → API). GET /v1/models lists just the
 * models currently loaded, and /v1/embeddings always embeds with the loaded
 * embedding model, whatever model id the request names.
 */
export class UnslothProvider extends OpenRouterProvider {
    protected override get defaultBaseUrl(): string { return 'http://localhost:8888/v1' }
    protected override get allowsCustomBaseUrl(): boolean { return true }
    protected override get defaultHeaders(): Record<string, string> { return {} }
    protected get supportsReasoningParam(): boolean { return false }

    private async fetchLoadedModels(): Promise<UnslothModel[]> {
        const baseUrl = this.config.baseUrl.replace(/\/+$/, '')
        const res = await fetch(`${baseUrl}/models`, {
            headers: this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}
        })
        if (!res.ok) return []
        const data = (await res.json()) as { data?: UnslothModel[] }
        return Array.isArray(data.data) ? data.data : []
    }

    async listModels(type?: ModelListType): Promise<string[]> {
        if (type && type !== 'llm' && type !== 'embedding') return []
        const ids = (await this.fetchLoadedModels()).map((m) => m.id).sort()
        if (!type) return ids
        return ids.filter((id) => EMBEDDING_MODEL_PATTERN.test(id) === (type === 'embedding'))
    }

    async listModelItems(type?: ModelListType): Promise<ModelListItem[]> {
        return (await this.listModels(type)).map((id) => ({ id }))
    }

    async getModelInfo(modelId: string): Promise<ModelInfo> {
        try {
            const model = (await this.fetchLoadedModels()).find((m) => m.id === modelId)
            return {
                id: modelId,
                contextLength: model?.context_length || model?.max_context_length || undefined
            }
        } catch {
            return { id: modelId }
        }
    }
}
