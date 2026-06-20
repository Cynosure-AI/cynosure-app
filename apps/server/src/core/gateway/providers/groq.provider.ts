import { OpenRouterProvider } from './openrouter.provider.js'
import type { ModelInfo, ModelListItem, ModelListType, TranscriptionRequest, TranscriptionResponse } from './base.provider.js'

/**
 * Groq provider — uses the OpenAI-compatible Chat Completions API
 * at https://api.groq.com/openai/v1.
 *
 * Groq offers extremely fast inference on open-source models
 * (Llama, Mixtral, Gemma, etc.) with a generous free tier.
 */
export class GroqProvider extends OpenRouterProvider {
    protected override get defaultBaseUrl(): string { return 'https://api.groq.com/openai/v1' }
    protected get supportsReasoningParam(): boolean { return false }
    private readonly transcriptionModels = new Set([
        'whisper-large-v3',
        'whisper-large-v3-turbo',
        'distil-whisper-large-v3-en'
    ])

    async listModels(_type?: ModelListType): Promise<string[]> {
        if (_type === 'video' || _type === 'image') return []
        // Groq uses the standard OpenAI models endpoint
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
        const models = data.data.map((m) => m.id).sort()
        if (_type === 'transcription') {
            return models.filter((id) => this.transcriptionModels.has(id))
        }
        return models
    }

    async listModelItems(type?: ModelListType): Promise<ModelListItem[]> {
        const models = await this.listModels(type)
        return models.map((id) => ({
            id,
            outputModalities: this.transcriptionModels.has(id) ? ['transcription'] : undefined
        }))
    }

    async transcribeAudio(request: TranscriptionRequest): Promise<TranscriptionResponse> {
        const baseUrl = this.config.baseUrl.replace(/\/+$/, '')
        const format = request.inputAudio.format || 'webm'
        const audioBuffer = Buffer.from(request.inputAudio.data, 'base64')
        const body = new FormData()
        body.set('model', request.model)
        body.set('file', new Blob([audioBuffer]), `audio.${format}`)
        if (request.language) body.set('language', request.language)
        if (request.temperature != null) body.set('temperature', String(request.temperature))

        const res = await fetch(`${baseUrl}/audio/transcriptions`, {
            method: 'POST',
            headers: this.config.apiKey
                ? { Authorization: `Bearer ${this.config.apiKey}` }
                : {},
            body,
            signal: request.signal
        })

        if (!res.ok) {
            let detail = `${res.status} ${res.statusText}`
            try {
                const data = await res.json() as { error?: { message?: string } | string; message?: string }
                const message = typeof data.error === 'string'
                    ? data.error
                    : data.error?.message || data.message
                if (message) detail = message
            } catch {
                const text = await res.text().catch(() => '')
                if (text) detail = text
            }
            throw new Error(`Groq transcription request failed: ${detail}`)
        }

        return await res.json() as TranscriptionResponse
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
                data: Array<{ id: string; context_window?: number }>
            }
            const model = data.data.find(m => m.id === modelId)
            return {
                id: modelId,
                contextLength: model?.context_window || undefined,
                outputModalities: this.transcriptionModels.has(modelId) ? ['transcription'] : undefined
            }
        } catch {
            return { id: modelId }
        }
    }
}
