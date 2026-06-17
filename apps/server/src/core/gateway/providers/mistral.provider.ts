import { OpenRouterProvider } from './openrouter.provider.js'
import type { ModelInfo, ModelListType } from './base.provider.js'

/**
 * Mistral provider — uses the OpenAI-compatible Chat Completions API
 * at https://api.mistral.ai/v1.
 */
export class MistralProvider extends OpenRouterProvider {
    protected override get defaultBaseUrl(): string { return 'https://api.mistral.ai/v1' }
    protected get supportsReasoningParam(): boolean { return false }

    async listModels(_type?: ModelListType): Promise<string[]> {
        if (_type === 'video' || _type === 'image') return []
        const baseUrl = this.config.baseUrl.replace(/\/+$/, '')

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
            const baseUrl = this.config.baseUrl.replace(/\/+$/, '')

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

    async getModelInfo(modelId: string): Promise<ModelInfo> {
        const baseUrl = this.config.baseUrl.replace(/\/+$/, '')
        try {
            const res = await fetch(`${baseUrl}/models`, {
                headers: this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}
            })
            if (!res.ok) return { id: modelId }
            const data = (await res.json()) as {
                data: Array<{ id: string; max_context_length?: number }>
            }
            const model = data.data.find(m => m.id === modelId)
            return {
                id: modelId,
                contextLength: model?.max_context_length || undefined
            }
        } catch {
            return { id: modelId }
        }
    }
}
