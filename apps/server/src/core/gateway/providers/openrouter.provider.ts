import OpenAI from 'openai'
import {
    BaseLLMProvider,
    IncompleteModelResponseError,
    type LLMProviderConfig,
    type CompletionRequest,
    type CompletionResponse,
    type StreamChunk,
    type ChatMessage,
    type ContentPart,
    type ToolCall,
    type ModelInfo,
    type ModelListItem,
    type ModelListType,
    type ModelPricing,
    type TranscriptionRequest,
    type TranscriptionResponse,
    type VideoGenerationContent,
    type VideoGenerationJob,
    type VideoGenerationModelInfo,
    type VideoGenerationRequest
} from './base.provider.js'
import { ensurePricingLoaded, getModelOutputModalities, modelSupportsOutputModality } from '../../model-dev-fetcher.js'

const MODEL_CACHE_TTL_MS = 10 * 60 * 1000

/**
 * OpenRouter's models endpoint currently reports reranker prompt/completion
 * pricing as zero even when the model is billed using rerank-specific units.
 * Keep the billing SKUs that OpenRouter publishes on its model pages here so
 * model pickers can show the actual price instead of only a "Rerank" badge.
 */
const RERANKER_PRICING_SKUS: Record<string, Record<string, number>> = {
    'cohere/rerank-v3.5': { per_search: 0.001 },
    'cohere/rerank-4-fast': { per_search: 0.002 },
    'cohere/rerank-4-pro': { per_search: 0.0025 },
    'nvidia/llama-nemotron-rerank-vl-1b-v2:free': { input_tokens: 0 },
    'voyageai/rerank-2.5': { input_tokens: 0.00000005 },
    'voyageai/rerank-2.5-lite': { input_tokens: 0.00000002 }
}

/**
 * The generic models endpoint encodes some duration-billed transcription
 * models in token-like prompt fields. Prefer the public headline billing unit
 * when OpenRouter publishes one, so the UI never labels that raw field as a
 * per-minute price.
 */
const TRANSCRIPTION_PRICING_SKUS: Record<string, Record<string, number>> = {
    'openai/whisper-large-v3': { per_audio_minute: 0.0015 }
}

interface OpenRouterModel {
    id: string
    context_length?: number
    input_modalities?: unknown
    output_modalities?: unknown
    supported_parameters?: unknown
    name?: string
    pricing?: Record<string, unknown>
    architecture?: {
        input_modalities?: unknown
        output_modalities?: unknown
        modality?: unknown
    }
}

interface OpenRouterImageModel {
    id: string
    name?: string
    endpoints?: string
    architecture?: {
        input_modalities?: unknown
        output_modalities?: unknown
    }
}

interface OpenRouterImagePricingLine {
    billable?: unknown
    unit?: unknown
    cost_usd?: unknown
    variant?: unknown
}

interface OpenRouterImageEndpoint {
    pricing?: OpenRouterImagePricingLine[]
}

/**
 * OpenRouter provider — uses the OpenAI-compatible Chat Completions API
 * at https://openrouter.ai/api/v1.
 *
 * OpenRouter routes requests to hundreds of models from various providers
 * (OpenAI, Anthropic, Google, Meta, etc.) through a single endpoint.
 */
export class OpenRouterProvider extends BaseLLMProvider {
    readonly config: LLMProviderConfig
    private client: OpenAI
    private modelsCache: { models: OpenRouterModel[]; ts: number } | null = null
    private imageModelsCache: { models: ModelListItem[]; ts: number } | null = null
    private imageModelsPromise: Promise<ModelListItem[]> | null = null
    protected get defaultBaseUrl(): string { return 'https://openrouter.ai/api/v1' }

    /** Whether this provider supports OpenRouter's native reasoning parameter */
    protected get supportsReasoningParam(): boolean { return true }

    constructor(config: LLMProviderConfig) {
        super()
        const baseUrl = this.defaultBaseUrl
        this.config = { ...config, baseUrl }
        this.client = new OpenAI({
            apiKey: config.apiKey || 'not-set',
            baseURL: baseUrl,
            defaultHeaders: {
                'HTTP-Referer': 'https://cynosure.app',
                'X-OpenRouter-Title': 'Cynosure'
            }
        })
    }

    /** Extract <think>...</think> blocks from content (Qwen, DeepSeek, etc.) */
    private separateThinking(content: string): { text: string; thinking: string } {
        const thinkRegex = /<think>([\s\S]*?)<\/think>/g
        let thinking = ''
        let text = content
        let match: RegExpExecArray | null
        while ((match = thinkRegex.exec(content)) !== null) {
            thinking += match[1].trim() + '\n'
        }
        if (thinking) {
            text = content.replace(thinkRegex, '').trim()
            thinking = thinking.trim()
        }
        return { text, thinking }
    }

    private async fetchModels(): Promise<OpenRouterModel[]> {
        if (this.modelsCache && Date.now() - this.modelsCache.ts < MODEL_CACHE_TTL_MS) {
            return this.modelsCache.models
        }

        const baseUrl = this.config.baseUrl.replace(/\/+$/, '')
        const res = await fetch(`${baseUrl}/models?output_modalities=all`, {
            headers: this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}
        })
        if (!res.ok) return []

        const data = (await res.json()) as { data?: OpenRouterModel[] }
        const models = Array.isArray(data.data) ? data.data : []
        this.modelsCache = { models, ts: Date.now() }
        return models
    }

    private getModalities(raw: unknown): string[] {
        if (!Array.isArray(raw)) return []
        return raw.filter((item): item is string => typeof item === 'string').map((item) => item.toLowerCase())
    }

    private getModalitiesFromDescriptor(model: OpenRouterModel | undefined, direction: 'input' | 'output'): string[] {
        const raw = model?.architecture?.modality
        if (typeof raw !== 'string' || !raw.includes('->')) return []
        const [input, output] = raw.split('->', 2)
        const selected = direction === 'input' ? input : output
        return selected
            .split(/[,+/|&\s]+/)
            .map((item) => item.trim().toLowerCase())
            .filter(Boolean)
    }

    private getInputModalities(model: OpenRouterModel | undefined): string[] {
        const modalities = this.getModalities(model?.input_modalities ?? model?.architecture?.input_modalities)
        return modalities.length ? modalities : this.getModalitiesFromDescriptor(model, 'input')
    }

    private getOutputModalities(model: OpenRouterModel | undefined): string[] {
        const modalities = this.getModalities(model?.output_modalities ?? model?.architecture?.output_modalities)
        return modalities.length ? modalities : this.getModalitiesFromDescriptor(model, 'output')
    }

    private modelListOutputModality(type?: ModelListType): string {
        switch (type) {
            case 'embedding': return 'embeddings'
            case 'image': return 'image'
            case 'video': return 'video'
            case 'reranker': return 'rerank'
            case 'transcription': return 'transcription'
            default: return 'text'
        }
    }

    private modelSupportsToolCalls(model: OpenRouterModel | undefined): boolean | undefined {
        if (!model || !Array.isArray(model.supported_parameters)) return undefined
        const supported = model.supported_parameters
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.toLowerCase())
        return supported.includes('tools')
    }

    private parsePrice(value: unknown): number | undefined {
        if (typeof value === 'number' && Number.isFinite(value)) return value
        if (typeof value !== 'string' || !value.trim()) return undefined
        const parsed = Number(value.trim().replace(/^\$/, '').replace(/,/g, ''))
        return Number.isFinite(parsed) ? parsed : undefined
    }

    private getPricing(pricing: Record<string, unknown> | null | undefined): ModelPricing | undefined {
        if (!pricing) return undefined
        const result: ModelPricing = {}
        const prompt = this.parsePrice(pricing.prompt)
        const completion = this.parsePrice(pricing.completion)
        const request = this.parsePrice(pricing.request)
        const image = this.parsePrice(pricing.image)
        const audio = this.parsePrice(pricing.audio)
        const webSearch = this.parsePrice(pricing.web_search)
        const internalReasoning = this.parsePrice(pricing.internal_reasoning)
        const inputCacheRead = this.parsePrice(pricing.input_cache_read)
        const inputCacheWrite = this.parsePrice(pricing.input_cache_write)
        if (prompt !== undefined) result.prompt = prompt
        if (completion !== undefined) result.completion = completion
        if (request !== undefined) result.request = request
        if (image !== undefined) result.image = image
        if (audio !== undefined) result.audio = audio
        if (webSearch !== undefined) result.webSearch = webSearch
        if (internalReasoning !== undefined) result.internalReasoning = internalReasoning
        if (inputCacheRead !== undefined) result.inputCacheRead = inputCacheRead
        if (inputCacheWrite !== undefined) result.inputCacheWrite = inputCacheWrite
        const tiers = this.getPricingTiers(pricing.overrides)
        if (tiers.length) result.tiers = tiers
        const knownPricingKeys = new Set([
            'prompt',
            'completion',
            'request',
            'image',
            'audio',
            'web_search',
            'internal_reasoning',
            'input_cache_read',
            'input_cache_write',
            'overrides'
        ])
        const skus: Record<string, number> = {}
        for (const [key, value] of Object.entries(pricing)) {
            if (knownPricingKeys.has(key)) continue
            const parsed = this.parsePrice(value)
            if (parsed !== undefined) skus[key] = parsed
        }
        if (Object.keys(skus).length) result.skus = skus
        return Object.keys(result).length ? result : undefined
    }

    private getPricingTiers(raw: unknown): NonNullable<ModelPricing['tiers']> {
        if (!Array.isArray(raw)) return []
        return raw.flatMap((item): NonNullable<ModelPricing['tiers']> => {
            if (!item || typeof item !== 'object') return []
            const value = item as Record<string, unknown>
            const prompt = this.parsePrice(value.prompt)
            const completion = this.parsePrice(value.completion)
            const inputCacheRead = this.parsePrice(value.input_cache_read)
            const inputCacheWrite = this.parsePrice(value.input_cache_write)
            const minPromptTokens = this.parsePrice(value.min_prompt_tokens)
            const utcStart = this.parsePrice(value.utc_start)
            const utcEnd = this.parsePrice(value.utc_end)
            if (
                prompt == null && completion == null && inputCacheRead == null &&
                inputCacheWrite == null
            ) return []
            return [{
                ...(prompt != null ? { prompt } : {}),
                ...(completion != null ? { completion } : {}),
                ...(inputCacheRead != null ? { inputCacheRead } : {}),
                ...(inputCacheWrite != null ? { inputCacheWrite } : {}),
                ...(minPromptTokens != null ? { minPromptTokens } : {}),
                ...(utcStart != null ? { utcStart } : {}),
                ...(utcEnd != null ? { utcEnd } : {})
            }]
        })
    }

    private getSkuPricing(skus: Record<string, string> | null | undefined): Record<string, number> | undefined {
        if (!skus) return undefined
        const result: Record<string, number> = {}
        for (const [key, value] of Object.entries(skus)) {
            const parsed = this.parsePrice(value)
            if (parsed !== undefined) result[key] = parsed
        }
        return Object.keys(result).length ? result : undefined
    }

    private imagePricingFromEndpoints(endpoints: OpenRouterImageEndpoint[]): ModelPricing | undefined {
        const pricing: ModelPricing = {}
        const skus: Record<string, number> = {}
        const outputImagePrices: number[] = []

        for (const endpoint of endpoints) {
            for (const line of endpoint.pricing ?? []) {
                if (typeof line.billable !== 'string' || typeof line.unit !== 'string') continue
                const cost = this.parsePrice(line.cost_usd)
                if (cost == null) continue

                const billable = line.billable.toLowerCase()
                const unit = line.unit.toLowerCase()
                const variant = typeof line.variant === 'string' && line.variant.trim()
                    ? `_${line.variant.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')}`
                    : ''
                const sku = `${billable}${variant}_per_${unit}`
                skus[sku] = cost
                if (billable === 'output_image' && unit === 'image') outputImagePrices.push(cost)
            }
        }

        // The compact picker price should represent generated output. The generic
        // models feed's `image` field can instead be the input-reference charge.
        if (outputImagePrices.length) pricing.image = Math.min(...outputImagePrices)
        if (Object.keys(skus).length) pricing.skus = skus
        return Object.keys(pricing).length ? pricing : undefined
    }

    private async fetchImageEndpointPricing(path: string): Promise<ModelPricing | undefined> {
        try {
            const data = await this.requestOpenRouter<{ endpoints?: OpenRouterImageEndpoint[] }>(path)
            return this.imagePricingFromEndpoints(Array.isArray(data.endpoints) ? data.endpoints : [])
        } catch {
            return undefined
        }
    }

    private async listImageModelItems(): Promise<ModelListItem[]> {
        if (this.imageModelsCache && Date.now() - this.imageModelsCache.ts < MODEL_CACHE_TTL_MS) {
            return this.imageModelsCache.models
        }
        if (this.imageModelsPromise) return this.imageModelsPromise

        this.imageModelsPromise = (async () => {
            const data = await this.requestOpenRouter<{ data?: OpenRouterImageModel[] }>('/images/models')
            const imageModels = Array.isArray(data.data) ? data.data : []
            const models: ModelListItem[] = []
            // Avoid opening dozens of endpoint requests at once while still keeping
            // picker refreshes reasonably quick.
            for (let index = 0; index < imageModels.length; index += 8) {
                const batch = imageModels.slice(index, index + 8)
                models.push(...await Promise.all(batch.map(async (model): Promise<ModelListItem> => {
                    const inputModalities = this.getModalities(model.architecture?.input_modalities)
                    const outputModalities = this.getModalities(model.architecture?.output_modalities)
                    const endpointPath = (model.endpoints || `/images/models/${model.id}/endpoints`)
                        .replace(/^\/api\/v1(?=\/)/, '')
                    return {
                        id: model.id,
                        name: model.name,
                        inputModalities: inputModalities.length ? inputModalities : undefined,
                        outputModalities: outputModalities.length ? outputModalities : ['image'],
                        pricing: await this.fetchImageEndpointPricing(endpointPath)
                    }
                })))
            }
            models.sort((a, b) => a.id.localeCompare(b.id))
            this.imageModelsCache = { models, ts: Date.now() }
            return models
        })()

        try {
            return await this.imageModelsPromise
        } finally {
            this.imageModelsPromise = null
        }
    }

    private toModelListItem(model: OpenRouterModel): ModelListItem {
        const inputModalities = this.getInputModalities(model)
        const outputModalities = this.getOutputModalities(model)
        const pricing = this.getPricing(model.pricing)
        const rerankerSkus = outputModalities.includes('rerank')
            ? RERANKER_PRICING_SKUS[model.id]
            : undefined
        const transcriptionSkus = outputModalities.includes('transcription')
            ? TRANSCRIPTION_PRICING_SKUS[model.id]
            : undefined
        const durationBilledTranscription = Boolean(transcriptionSkus)
        return {
            id: model.id,
            name: model.name,
            contextLength: model.context_length || undefined,
            inputModalities: inputModalities.length ? inputModalities : undefined,
            outputModalities: outputModalities.length ? outputModalities : undefined,
            supportsToolCalls: this.modelSupportsToolCalls(model),
            pricing: pricing || rerankerSkus || transcriptionSkus
                ? {
                    ...pricing,
                    ...(durationBilledTranscription ? { prompt: 0, completion: 0 } : {}),
                    skus: {
                        ...pricing?.skus,
                        ...rerankerSkus,
                        ...transcriptionSkus
                    }
                }
                : undefined
        }
    }

    private async modelSupportsImageOutput(modelId: string): Promise<boolean> {
        await ensurePricingLoaded().catch(() => { /* best-effort capability metadata */ })
        const supportsImageOutput = modelSupportsOutputModality(this.config.type, modelId, 'image')
        if (supportsImageOutput != null) return supportsImageOutput

        try {
            const models = await this.fetchModels()
            const model = models.find(m => m.id === modelId)
            return this.getOutputModalities(model).includes('image')
        } catch {
            return false
        }
    }

    private async getImageGenerationModalities(modelId: string): Promise<string[] | undefined> {
        await ensurePricingLoaded().catch(() => { /* best-effort capability metadata */ })
        const modelsDevModalities = getModelOutputModalities(this.config.type, modelId)
            ?.map((item) => item.toLowerCase())
        if (modelsDevModalities?.includes('image')) {
            return modelsDevModalities.includes('text') ? ['image', 'text'] : ['image']
        }

        try {
            const models = await this.fetchModels()
            const model = models.find(m => m.id === modelId)
            const outputModalities = this.getOutputModalities(model)
            if (outputModalities.includes('image')) {
                return outputModalities.includes('text') ? ['image', 'text'] : ['image']
            }
        } catch {
            // Fall through to the conservative default below.
        }

        if (await this.modelSupportsImageOutput(modelId)) {
            return ['image', 'text']
        }

        return undefined
    }

    private audioInputPart(url: string): Record<string, unknown> | null {
        const match = url.match(/^data:audio\/([^;,]+)(?:;[^,]*)?;base64,(.+)$/i)
        if (!match) return null
        const subtype = match[1].toLowerCase()
        const format = subtype === 'mpeg' ? 'mp3' : subtype === 'x-m4a' ? 'm4a' : subtype
        return {
            type: 'input_audio',
            input_audio: { data: match[2], format }
        }
    }

    private async requestOpenRouter<T>(
        pathOrUrl: string,
        init: RequestInit = {}
    ): Promise<T> {
        const baseUrl = this.config.baseUrl.replace(/\/+$/, '')
        const url = pathOrUrl.startsWith('http')
            ? pathOrUrl
            : `${baseUrl}${pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`}`
        const headers = new Headers(init.headers)
        if (this.config.apiKey) headers.set('Authorization', `Bearer ${this.config.apiKey}`)
        if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

        const res = await fetch(url, { ...init, headers })
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
            throw new Error(`OpenRouter request failed: ${detail}`)
        }

        return await res.json() as T
    }

    private async requestOpenRouterContent(pathOrUrl: string): Promise<VideoGenerationContent> {
        const baseUrl = this.config.baseUrl.replace(/\/+$/, '')
        const url = pathOrUrl.startsWith('http')
            ? pathOrUrl
            : `${baseUrl}${pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`}`
        const headers = new Headers()
        if (this.config.apiKey) headers.set('Authorization', `Bearer ${this.config.apiKey}`)

        const res = await fetch(url, { headers })
        if (!res.ok) {
            throw new Error(`OpenRouter content request failed: ${res.status} ${res.statusText}`)
        }

        return {
            data: await res.arrayBuffer(),
            contentType: res.headers.get('content-type') || 'video/mp4'
        }
    }

    private extractImageUrls(source: unknown): string[] {
        const images = (source as { images?: unknown } | undefined)?.images
        if (!Array.isArray(images)) return []

        const urls: string[] = []
        for (const image of images) {
            const item = image as {
                image_url?: { url?: unknown }
                imageUrl?: { url?: unknown }
            }
            const url = item.image_url?.url ?? item.imageUrl?.url
            if (typeof url === 'string' && !urls.includes(url)) urls.push(url)
        }
        return urls
    }

    private isToolSupportRoutingError(err: unknown): boolean {
        const message = err instanceof Error ? err.message : String(err)
        return /support tool use|tool use|tools?/i.test(message) && /no endpoints?|unsupported|not support/i.test(message)
    }

    private assertCompleteFinishReason(reason: string | null | undefined): void {
        if (reason === 'stop' || reason === 'tool_calls' || reason === 'function_call') return
        throw new IncompleteModelResponseError(reason || 'missing_finish_reason')
    }

    /** Convert internal messages to OpenAI Chat Completions format */
    private formatMessages(
        messages: ChatMessage[]
    ): OpenAI.Chat.ChatCompletionMessageParam[] {
        return messages.flatMap((msg): OpenAI.Chat.ChatCompletionMessageParam[] => {
            if (msg.role === 'system') {
                return [{
                    role: 'system' as const,
                    content:
                        typeof msg.content === 'string'
                            ? msg.content
                            : this.getTextContent(msg.content)
                }]
            }

            if (msg.role === 'tool') {
                const toolMsg: OpenAI.Chat.ChatCompletionMessageParam = {
                    role: 'tool' as const,
                    tool_call_id: msg.toolCallId || '',
                    content:
                        typeof msg.content === 'string'
                            ? msg.content
                            : this.getTextContent(msg.content)
                }
                // If the tool returned images, inject them as a follow-up user message
                // because the Chat Completions tool role only supports text content
                if (Array.isArray(msg.content)) {
                    const imageParts = (msg.content as ContentPart[])
                        .filter((p) => p.type === 'image_url')
                        .map((p) => ({
                            type: 'image_url' as const,
                            image_url: { url: (p as { type: 'image_url'; image_url: { url: string } }).image_url.url }
                        }))
                    if (imageParts.length) {
                        const imageFollowUp: OpenAI.Chat.ChatCompletionMessageParam = {
                            role: 'user' as const,
                            content: [
                                { type: 'text' as const, text: 'Here is the visual output from the tool:' },
                                ...imageParts
                            ]
                        }
                        return [toolMsg, imageFollowUp]
                    }
                }
                return [toolMsg]
            }

            if (msg.role === 'assistant') {
                const result: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
                    role: 'assistant' as const,
                    content:
                        typeof msg.content === 'string'
                            ? msg.content
                            : this.getTextContent(msg.content)
                }
                if (msg.toolCalls?.length) {
                    result.tool_calls = msg.toolCalls.map((tc) => ({
                        id: tc.id,
                        type: 'function' as const,
                        function: {
                            name: tc.function.name,
                            arguments: tc.function.arguments
                        }
                    }))
                }
                return [result]
            }

            // user message
            if (typeof msg.content === 'string') {
                return [{ role: 'user' as const, content: msg.content }]
            }

            // multimodal user message
            const parts = (
                msg.content as ContentPart[]
            ).map((part) => {
                if (part.type === 'text') {
                    return { type: 'text' as const, text: part.text }
                }
                if (part.type === 'image_url') {
                    return {
                        type: 'image_url' as const,
                        image_url: { url: part.image_url.url }
                    }
                }
                const url = (part as { type: 'audio_url'; audio_url: { url: string } }).audio_url.url
                return this.audioInputPart(url) || { type: 'text' as const, text: `[Audio: ${url}]` }
            })
            return [{
                role: 'user' as const,
                content: parts as unknown as OpenAI.Chat.ChatCompletionContentPart[]
            }]
        })
    }

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
        const start = Date.now()
        const messages = this.formatMessages(request.messages)
        const model = request.model || this.config.defaultModel

        const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & Record<string, unknown> = {
            model,
            messages,
            max_tokens: request.maxTokens,
            stream: false
        }
        if (request.temperature != null) params.temperature = request.temperature
        const imageModalities = await this.getImageGenerationModalities(model)
        if (imageModalities) {
            const imageParams = params as Record<string, unknown>
            imageParams.modalities = imageModalities
        }
        // Send reasoning parameter for OpenRouter native thinking support
        if (this.supportsReasoningParam) {
            params.reasoning = request.thinkingEnabled === false
                ? { enabled: false }
                : { effort: request.reasoningEffort ?? 'medium' }
        }

        if (request.tools?.length) {
            params.tools = this.formatToolsForProvider(request.tools) as unknown as OpenAI.Chat.ChatCompletionTool[]
        }
        if (request.toolChoice) {
            params.tool_choice = {
                type: 'function',
                function: { name: request.toolChoice.name }
            }
        }

        let response: OpenAI.Chat.ChatCompletion
        try {
            response = await this.client.chat.completions.create(params as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming, {
                signal: request.signal
            })
        } catch (err) {
            if (!request.toolChoice && request.tools?.length && this.isToolSupportRoutingError(err)) {
                delete params.tools
                delete params.tool_choice
                response = await this.client.chat.completions.create(params as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming, {
                    signal: request.signal
                })
            } else {
                throw err
            }
        }

        const choice = response.choices[0]
        this.assertCompleteFinishReason(choice?.finish_reason)
        const msg = choice?.message as unknown as Record<string, unknown> | undefined
        const rawContent = (msg?.content as string) || ''
        const { text, thinking: tagThinking } = this.separateThinking(rawContent)
        const images = this.extractImageUrls(msg)

        // Extract native reasoning from OpenRouter response (reasoning field or reasoning_details)
        let nativeReasoning = ''
        if (msg?.reasoning && typeof msg.reasoning === 'string') {
            nativeReasoning = msg.reasoning
        } else if (Array.isArray(msg?.reasoning_details)) {
            for (const detail of msg.reasoning_details as Array<Record<string, unknown>>) {
                if (detail.type === 'reasoning.text' && typeof detail.text === 'string') {
                    nativeReasoning += detail.text
                } else if (detail.type === 'reasoning.summary' && typeof detail.summary === 'string') {
                    nativeReasoning += detail.summary
                }
            }
        }

        // Prefer native reasoning; fall back to <think> tag extraction
        const combinedThinking = nativeReasoning || tagThinking || ''

        const toolCalls: ToolCall[] | undefined = (
            choice?.message?.tool_calls as
            | Array<{ id: string; type: string; function: { name: string; arguments: string } }>
            | undefined
        )?.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
                name: tc.function.name,
                arguments: tc.function.arguments
            }
        }))

        return {
            id: response.id,
            content: text,
            thinking: combinedThinking || undefined,
            toolCalls: toolCalls?.length ? toolCalls : undefined,
            images: images.length ? images : undefined,
            usage: {
                promptTokens: response.usage?.prompt_tokens || 0,
                completionTokens: response.usage?.completion_tokens || 0,
                totalTokens: response.usage?.total_tokens || 0
            },
            model: response.model || request.model || this.config.defaultModel,
            provider: this.config.id,
            latencyMs: Date.now() - start
        }
    }

    async *streamComplete(
        request: CompletionRequest
    ): AsyncIterable<StreamChunk> {
        const messages = this.formatMessages(request.messages)
        const model = request.model || this.config.defaultModel

        const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming & Record<string, unknown> = {
            model,
            messages,
            max_tokens: request.maxTokens,
            stream: true,
            stream_options: { include_usage: true }
        }
        if (request.temperature != null) params.temperature = request.temperature
        const imageModalities = await this.getImageGenerationModalities(model)
        if (imageModalities) {
            const imageParams = params as Record<string, unknown>
            imageParams.modalities = imageModalities
        }

        // Send reasoning parameter for OpenRouter native thinking support
        if (this.supportsReasoningParam) {
            params.reasoning = request.thinkingEnabled === false
                ? { enabled: false }
                : { effort: request.reasoningEffort ?? 'medium' }
        }

        if (request.tools?.length) {
            params.tools = this.formatToolsForProvider(request.tools) as unknown as OpenAI.Chat.ChatCompletionTool[]
        }
        if (request.toolChoice) {
            params.tool_choice = {
                type: 'function',
                function: { name: request.toolChoice.name }
            }
        }

        let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>
        try {
            stream = await this.client.chat.completions.create(params as OpenAI.Chat.ChatCompletionCreateParamsStreaming, {
                signal: request.signal
            })
        } catch (err) {
            if (!request.toolChoice && request.tools?.length && this.isToolSupportRoutingError(err)) {
                delete params.tools
                delete params.tool_choice
                stream = await this.client.chat.completions.create(params as OpenAI.Chat.ChatCompletionCreateParamsStreaming, {
                    signal: request.signal
                })
            } else {
                throw err
            }
        }

        const toolCallAccumulator = new Map<
            number,
            { id: string; name: string; arguments: string }
        >()

        // State machine for streaming <think> tag extraction
        let insideThink = false
        let tagBuffer = ''
        // When a model provides native reasoning fields, skip <think> tag
        // parsing to avoid yielding thinking tokens twice.
        let nativeReasoningDetected = false

        // Track finish state — usage may arrive in a separate chunk AFTER
        // the finish_reason chunk (OpenAI-compatible streaming protocol).
        let finished = false
        let terminalFinishReason: string | null = null
        let finishedUsage: StreamChunk['usage']
        const streamedImages = new Set<string>()

        for await (const chunk of stream) {
            const delta = chunk.choices?.[0]?.delta
            const deltaImages = this.extractImageUrls(delta)
                .filter((url) => {
                    if (streamedImages.has(url)) return false
                    streamedImages.add(url)
                    return true
                })
            if (deltaImages.length) {
                yield { images: deltaImages, done: false }
            }

            // Handle tool call deltas
            if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                    const idx = tc.index
                    if (!toolCallAccumulator.has(idx)) {
                        toolCallAccumulator.set(idx, {
                            id: tc.id || '',
                            name: tc.function?.name || '',
                            arguments: ''
                        })
                    }
                    const acc = toolCallAccumulator.get(idx)!
                    if (tc.id) acc.id = tc.id
                    if (tc.function?.name) acc.name = tc.function.name
                    if (tc.function?.arguments) acc.arguments += tc.function.arguments
                }
            }

            // Handle native reasoning from OpenRouter (Claude, OpenAI o-series, Kimi, etc.)
            // OpenRouter sends the same text in BOTH delta.reasoning AND delta.reasoning_details,
            // so we only consume delta.reasoning to avoid doubling.
            const deltaAny = delta as Record<string, unknown> | undefined
            if (deltaAny?.reasoning && typeof deltaAny.reasoning === 'string') {
                nativeReasoningDetected = true
                yield { thinking: deltaAny.reasoning, done: false }
            } else if (Array.isArray(deltaAny?.reasoning_details)) {
                // Fallback: if reasoning field is absent but reasoning_details exists
                for (const detail of deltaAny.reasoning_details as Array<Record<string, unknown>>) {
                    if (detail.type === 'reasoning.text' && typeof detail.text === 'string') {
                        nativeReasoningDetected = true
                        yield { thinking: detail.text, done: false }
                    } else if (detail.type === 'reasoning.summary' && typeof detail.summary === 'string') {
                        nativeReasoningDetected = true
                        yield { thinking: detail.summary, done: false }
                    }
                }
            }

            // Handle content deltas with <think> tag parsing
            // Skip tag parsing when native reasoning is active to avoid doubling.
            if (delta?.content && !nativeReasoningDetected) {
                let raw = tagBuffer + delta.content
                tagBuffer = ''
                let contentOut = ''
                let thinkingOut = ''

                while (raw.length > 0) {
                    if (insideThink) {
                        const closeIdx = raw.indexOf('</think>')
                        if (closeIdx !== -1) {
                            thinkingOut += raw.slice(0, closeIdx)
                            raw = raw.slice(closeIdx + 8)
                            insideThink = false
                        } else {
                            const partialClose = this.findPartialTag(raw, '</think>')
                            if (partialClose > 0) {
                                thinkingOut += raw.slice(0, raw.length - partialClose)
                                tagBuffer = raw.slice(raw.length - partialClose)
                                raw = ''
                            } else {
                                thinkingOut += raw
                                raw = ''
                            }
                        }
                    } else {
                        const openIdx = raw.indexOf('<think>')
                        if (openIdx !== -1) {
                            contentOut += raw.slice(0, openIdx)
                            raw = raw.slice(openIdx + 7)
                            insideThink = true
                        } else {
                            const partialOpen = this.findPartialTag(raw, '<think>')
                            if (partialOpen > 0) {
                                contentOut += raw.slice(0, raw.length - partialOpen)
                                tagBuffer = raw.slice(raw.length - partialOpen)
                                raw = ''
                            } else {
                                contentOut += raw
                                raw = ''
                            }
                        }
                    }
                }

                if (thinkingOut) yield { thinking: thinkingOut, done: false }
                if (contentOut) yield { content: contentOut, done: false }
            } else if (delta?.content && nativeReasoningDetected) {
                // Native reasoning is handling thinking — pass content through directly
                yield { content: delta.content, done: false }
            }

            // Capture usage from any chunk (may arrive on finish chunk or a separate subsequent one)
            if (chunk.usage) {
                finishedUsage = {
                    promptTokens: chunk.usage.prompt_tokens,
                    completionTokens: chunk.usage.completion_tokens,
                    totalTokens: chunk.usage.total_tokens
                }
            }

            // Check for finish
            const finishReason = chunk.choices?.[0]?.finish_reason
            if (finishReason) {
                finished = true
                terminalFinishReason = finishReason
                // Flush remaining tag buffer
                if (tagBuffer) {
                    if (insideThink) {
                        yield { thinking: tagBuffer, done: false }
                    } else {
                        yield { content: tagBuffer, done: false }
                    }
                    tagBuffer = ''
                }
            }
        }

        // Yield done after the stream ends so we capture usage from post-finish chunks
        if (finished) {
            this.assertCompleteFinishReason(terminalFinishReason)
            const completedToolCalls: ToolCall[] = Array.from(
                toolCallAccumulator.values()
            ).map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: tc.arguments }
            }))

            yield {
                done: true,
                toolCalls: completedToolCalls.length > 0 ? completedToolCalls : undefined,
                usage: finishedUsage
            }
        } else {
            throw new Error('Model stream ended before a finish reason was received.')
        }
    }

    async listModels(type?: ModelListType): Promise<string[]> {
        const baseUrl = this.config.baseUrl.replace(/\/+$/, '')

        const modality = this.modelListOutputModality(type)
        const url = `${baseUrl}/models?output_modalities=${modality}`

        const res = await fetch(url, {
            headers: this.config.apiKey
                ? { Authorization: `Bearer ${this.config.apiKey}` }
                : {}
        })

        if (!res.ok) {
            // Fall back to OpenAI SDK models list
            const models = await this.client.models.list()
            return models.data.map((m) => m.id).sort()
        }

        const data = (await res.json()) as {
            data: Array<{ id: string; name: string }>
        }
        return data.data.map((m) => m.id).sort()
    }

    async listModelItems(type?: ModelListType): Promise<ModelListItem[]> {
        if (type === 'image') return await this.listImageModelItems()

        if (type === 'video') {
            const models = await this.listVideoModels()
            return models.map((model) => ({
                id: model.id,
                name: model.name,
                outputModalities: ['video'],
                pricing: (() => {
                    const skus = this.getSkuPricing(model.pricing_skus)
                    return skus ? { skus } : undefined
                })()
            }))
        }

        const baseUrl = this.config.baseUrl.replace(/\/+$/, '')
        const modality = this.modelListOutputModality(type)
        const res = await fetch(`${baseUrl}/models?output_modalities=${modality}`, {
            headers: this.config.apiKey
                ? { Authorization: `Bearer ${this.config.apiKey}` }
                : {}
        })

        if (!res.ok) {
            return (await this.listModels(type)).map((id) => ({ id }))
        }

        const data = (await res.json()) as { data?: OpenRouterModel[] }
        return (Array.isArray(data.data) ? data.data : [])
            .map((model) => this.toModelListItem(model))
            .sort((a, b) => a.id.localeCompare(b.id))
    }

    async listVideoModels(): Promise<VideoGenerationModelInfo[]> {
        const data = await this.requestOpenRouter<{ data?: VideoGenerationModelInfo[] }>('/videos/models')
        return Array.isArray(data.data) ? data.data : []
    }

    async generateVideo(request: VideoGenerationRequest): Promise<VideoGenerationJob> {
        const { signal, ...payload } = request
        return await this.requestOpenRouter<VideoGenerationJob>('/videos', {
            method: 'POST',
            body: JSON.stringify(payload),
            signal
        })
    }

    async getVideoGenerationJob(jobIdOrUrl: string): Promise<VideoGenerationJob> {
        const path = jobIdOrUrl.startsWith('http')
            ? jobIdOrUrl
            : `/videos/${encodeURIComponent(jobIdOrUrl)}`
        return await this.requestOpenRouter<VideoGenerationJob>(path)
    }

    async getVideoGenerationContent(jobId: string, index = 0): Promise<VideoGenerationContent> {
        return await this.requestOpenRouterContent(`/videos/${encodeURIComponent(jobId)}/content?index=${encodeURIComponent(String(index))}`)
    }

    async transcribeAudio(request: TranscriptionRequest): Promise<TranscriptionResponse> {
        const { signal, inputAudio, ...rest } = request
        return await this.requestOpenRouter<TranscriptionResponse>('/audio/transcriptions', {
            method: 'POST',
            body: JSON.stringify({
                ...rest,
                input_audio: {
                    data: inputAudio.data,
                    ...(inputAudio.format ? { format: inputAudio.format } : {})
                }
            }),
            signal
        })
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

    /** Returns length of partial tag match at end of text, or 0 if none */
    private findPartialTag(text: string, tag: string): number {
        for (let len = Math.min(tag.length - 1, text.length); len > 0; len--) {
            if (text.endsWith(tag.slice(0, len))) return len
        }
        return 0
    }

    /**
     * Fetch model metadata from OpenRouter's models API.
     * The API returns context_length and output modalities for each model.
     */
    async getModelInfo(modelId: string): Promise<ModelInfo> {
        try {
            const models = await this.fetchModels()
            const model = models.find(m => m.id === modelId)
            if (!model) {
                const videoModel = (await this.listVideoModels().catch(() => []))
                    .find((item) => item.id === modelId)
                if (videoModel) {
                    const skus = this.getSkuPricing(videoModel.pricing_skus)
                    return {
                        id: modelId,
                        outputModalities: ['video'],
                        pricing: skus ? { skus } : undefined
                    }
                }
            }
            const inputModalities = this.getInputModalities(model)
            const outputModalities = this.getOutputModalities(model)
            let pricing = this.getPricing(model?.pricing)
            const transcriptionSkus = outputModalities.includes('transcription')
                ? TRANSCRIPTION_PRICING_SKUS[modelId]
                : undefined
            if (transcriptionSkus) {
                pricing = {
                    ...pricing,
                    prompt: 0,
                    completion: 0,
                    skus: { ...pricing?.skus, ...transcriptionSkus }
                }
            }
            if (outputModalities.includes('video')) {
                const videoModel = (await this.listVideoModels().catch(() => []))
                    .find((item) => item.id === modelId)
                const skus = this.getSkuPricing(videoModel?.pricing_skus)
                if (skus) {
                    pricing ??= {}
                    pricing.skus = { ...(pricing.skus ?? {}), ...skus }
                }
            }
            if (outputModalities.includes('image')) {
                const dedicatedPricing = await this.fetchImageEndpointPricing(`/images/models/${modelId}/endpoints`)
                if (dedicatedPricing) pricing = dedicatedPricing
            }
            return {
                id: modelId,
                contextLength: model?.context_length || undefined,
                inputModalities: inputModalities.length ? inputModalities : undefined,
                outputModalities: outputModalities.length ? outputModalities : undefined,
                supportsToolCalls: this.modelSupportsToolCalls(model),
                pricing
            }
        } catch {
            return { id: modelId }
        }
    }
}
