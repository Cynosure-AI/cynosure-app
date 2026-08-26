import type {
    CompletionRequest,
    ModelInfo,
    ModelListItem,
    ModelListType,
    ModelPricing,
    TranscriptionRequest,
    TranscriptionResponse,
    VideoGenerationModelInfo
} from './base.provider.js'
import { OpenRouterProvider } from './openrouter.provider.js'

const MODEL_CACHE_TTL_MS = 10 * 60 * 1000

interface RequestyPricingTier {
    prompt_tokens_threshold?: unknown
    input_price?: unknown
    output_price?: unknown
    cached_price?: unknown
    caching_price?: unknown
    caching_5m_price?: unknown
    caching_1h_price?: unknown
}

interface RequestyModel {
    api?: string
    id: string
    pricing?: RequestyPricingTier[] | Record<string, unknown>
    input_price?: unknown
    output_price?: unknown
    cached_price?: unknown
    caching_price?: unknown
    caching_5m_price?: unknown
    caching_1h_price?: unknown
    context_window?: number
    supports_vision?: boolean
    supports_image_generation?: boolean
    supports_tool_calling?: boolean
}

/**
 * Requesty provider — OpenAI-compatible chat completions routed through
 * https://router.requesty.ai/v1.
 */
export class RequestyProvider extends OpenRouterProvider {
    private modelCaches = new Map<string, { models: RequestyModel[]; ts: number }>()

    protected override get defaultBaseUrl(): string { return 'https://router.requesty.ai/v1' }

    protected override get defaultHeaders(): Record<string, string> {
        return {
            'HTTP-Referer': 'https://github.com/andreasjhagen/Cynosure',
            'X-Title': 'Cynosure'
        }
    }

    protected override addReasoningParams(
        params: Record<string, unknown>,
        request: CompletionRequest
    ): void {
        const effort = request.thinkingEnabled === false
            ? 'none'
            : request.reasoningEffort === 'minimal'
                ? 'min'
                : request.reasoningEffort ?? 'medium'
        params.reasoning_effort = effort
    }

    // Requesty image-capable chat models select image output from the model
    // itself; OpenRouter's `modalities` parameter is not required.
    protected override async getImageGenerationModalities(_modelId: string): Promise<string[] | undefined> {
        return undefined
    }

    private endpointForType(type?: ModelListType): string | null {
        switch (type) {
            case 'embedding': return 'embedding'
            case 'transcription': return 'transcription'
            case 'video':
            case 'reranker': return null
            default: return 'chat'
        }
    }

    private async fetchRequestyModels(endpoint: string): Promise<RequestyModel[]> {
        const cached = this.modelCaches.get(endpoint)
        if (cached && Date.now() - cached.ts < MODEL_CACHE_TTL_MS) return cached.models

        const baseUrl = this.config.baseUrl.replace(/\/+$/, '')
        const res = await fetch(`${baseUrl}/models/${endpoint}`, {
            headers: this.config.apiKey
                ? { Authorization: `Bearer ${this.config.apiKey}` }
                : {}
        })
        if (!res.ok) {
            throw new Error(`Requesty model listing failed: ${res.status} ${res.statusText}`)
        }

        const data = await res.json() as { data?: RequestyModel[] }
        const models = Array.isArray(data.data) ? data.data : []
        this.modelCaches.set(endpoint, { models, ts: Date.now() })
        return models
    }

    private number(value: unknown): number | undefined {
        return typeof value === 'number' && Number.isFinite(value) ? value : undefined
    }

    private tierPricing(tier: RequestyPricingTier): ModelPricing {
        const prompt = this.number(tier.input_price)
        const completion = this.number(tier.output_price)
        const inputCacheRead = this.number(tier.cached_price)
        const inputCacheWrite = this.number(tier.caching_price)
        const skus: Record<string, number> = {}
        const cacheWrite5m = this.number(tier.caching_5m_price)
        const cacheWrite1h = this.number(tier.caching_1h_price)
        if (cacheWrite5m != null) skus.cache_write_5m = cacheWrite5m
        if (cacheWrite1h != null) skus.cache_write_1h = cacheWrite1h
        return {
            ...(prompt != null ? { prompt } : {}),
            ...(completion != null ? { completion } : {}),
            ...(inputCacheRead != null ? { inputCacheRead } : {}),
            ...(inputCacheWrite != null ? { inputCacheWrite } : {}),
            ...(Object.keys(skus).length ? { skus } : {})
        }
    }

    private modelPricing(model: RequestyModel): ModelPricing | undefined {
        if (Array.isArray(model.pricing)) {
            const sorted = [...model.pricing].sort((a, b) =>
                (this.number(a.prompt_tokens_threshold) ?? 0) -
                (this.number(b.prompt_tokens_threshold) ?? 0)
            )
            const base = sorted[0] || model
            const result = this.tierPricing(base)
            const tiers = sorted.slice(1).map((tier) => ({
                ...this.tierPricing(tier),
                minPromptTokens: this.number(tier.prompt_tokens_threshold)
            }))
            if (tiers.length) result.tiers = tiers
            return Object.keys(result).length ? result : undefined
        }

        if (model.pricing && typeof model.pricing === 'object') {
            const raw = model.pricing
            const skus: Record<string, number> = {}
            for (const [key, value] of Object.entries(raw)) {
                const parsed = this.number(value)
                if (parsed != null) skus[key] = parsed
            }
            const prompt = this.number(raw.input_text)
            const completion = this.number(raw.output_text)
            const image = this.number(raw.output_image)
            return Object.keys(skus).length ? {
                ...(prompt != null ? { prompt } : {}),
                ...(completion != null ? { completion } : {}),
                ...(image != null ? { image } : {}),
                skus
            } : undefined
        }

        const direct = this.tierPricing(model)
        return Object.keys(direct).length ? direct : undefined
    }

    private toRequestyModelListItem(model: RequestyModel): ModelListItem {
        const api = model.api?.toLowerCase() || 'chat'
        let inputModalities: string[] = ['text']
        let outputModalities: string[] = ['text']

        if (api === 'embedding') outputModalities = ['embeddings']
        if (api === 'transcription') {
            inputModalities = ['audio']
            outputModalities = ['transcription']
        }
        if (api === 'image') outputModalities = ['image']
        if (api === 'chat') {
            if (model.supports_vision) inputModalities.push('image')
            if (model.supports_image_generation) outputModalities.push('image')
        }

        return {
            id: model.id,
            contextLength: model.context_window || undefined,
            inputModalities,
            outputModalities,
            supportsToolCalls: api === 'chat' ? model.supports_tool_calling : false,
            pricing: this.modelPricing(model)
        }
    }

    async listModels(type?: ModelListType): Promise<string[]> {
        const endpoint = this.endpointForType(type)
        if (!endpoint) return []
        const models = await this.fetchRequestyModels(endpoint)
        return models
            .filter((model) => type !== 'image' || model.supports_image_generation)
            .map((model) => model.id)
            .sort()
    }

    async listModelItems(type?: ModelListType): Promise<ModelListItem[]> {
        const endpoint = this.endpointForType(type)
        if (!endpoint) return []
        const models = await this.fetchRequestyModels(endpoint)
        return models
            .filter((model) => type !== 'image' || model.supports_image_generation)
            .map((model) => this.toRequestyModelListItem(model))
            .sort((a, b) => a.id.localeCompare(b.id))
    }

    async listVideoModels(): Promise<VideoGenerationModelInfo[]> {
        return []
    }

    async getModelInfo(modelId: string): Promise<ModelInfo> {
        try {
            for (const cached of this.modelCaches.values()) {
                const model = cached.models.find((item) => item.id === modelId)
                if (model) return this.toRequestyModelListItem(model)
            }
            const model = (await this.fetchRequestyModels('all')).find((item) => item.id === modelId)
            return model ? this.toRequestyModelListItem(model) : { id: modelId }
        } catch {
            return { id: modelId }
        }
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
                detail = typeof data.error === 'string'
                    ? data.error
                    : data.error?.message || data.message || detail
            } catch {
                const text = await res.text().catch(() => '')
                if (text) detail = text
            }
            throw new Error(`Requesty transcription request failed: ${detail}`)
        }

        return await res.json() as TranscriptionResponse
    }
}
