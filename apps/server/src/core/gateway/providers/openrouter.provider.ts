import OpenAI from 'openai'
import {
    BaseLLMProvider,
    type LLMProviderConfig,
    type CompletionRequest,
    type CompletionResponse,
    type StreamChunk,
    type ChatMessage,
    type ContentPart,
    type ToolCall,
    type ModelInfo,
    type ModelListType,
    type VideoGenerationContent,
    type VideoGenerationJob,
    type VideoGenerationModelInfo,
    type VideoGenerationRequest
} from './base.provider.js'
import { ensurePricingLoaded, getModelOutputModalities, modelSupportsOutputModality } from '../../model-dev-fetcher.js'

const MODEL_CACHE_TTL_MS = 10 * 60 * 1000

interface OpenRouterModel {
    id: string
    context_length?: number
    input_modalities?: unknown
    output_modalities?: unknown
    supported_parameters?: unknown
    architecture?: {
        input_modalities?: unknown
        output_modalities?: unknown
    }
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
        const res = await fetch(`${baseUrl}/models`, {
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

    private getInputModalities(model: OpenRouterModel | undefined): string[] {
        return this.getModalities(model?.input_modalities ?? model?.architecture?.input_modalities)
    }

    private getOutputModalities(model: OpenRouterModel | undefined): string[] {
        return this.getModalities(model?.output_modalities ?? model?.architecture?.output_modalities)
    }

    private modelSupportsToolCalls(model: OpenRouterModel | undefined): boolean | undefined {
        if (!model || !Array.isArray(model.supported_parameters)) return undefined
        const supported = model.supported_parameters
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.toLowerCase())
        return supported.includes('tools')
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
            const parts: OpenAI.Chat.ChatCompletionContentPart[] = (
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
                // audio_url → fallback to text
                return {
                    type: 'text' as const,
                    text: `[Audio: ${(part as { type: 'audio_url'; audio_url: { url: string } }).audio_url.url}]`
                }
            })
            return [{ role: 'user' as const, content: parts }]
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
            params.reasoning = { enabled: request.thinkingEnabled !== false }
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
            params.reasoning = { enabled: request.thinkingEnabled !== false }
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
        }
    }

    async listModels(type?: ModelListType): Promise<string[]> {
        const baseUrl = this.config.baseUrl.replace(/\/+$/, '')

        const modality = type === 'embedding'
            ? 'embeddings'
            : type === 'video'
                ? 'video'
                : type === 'image'
                    ? 'image'
                    : 'text'
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
            const inputModalities = this.getInputModalities(model)
            const outputModalities = this.getOutputModalities(model)
            return {
                id: modelId,
                contextLength: model?.context_length || undefined,
                inputModalities: inputModalities.length ? inputModalities : undefined,
                outputModalities: outputModalities.length ? outputModalities : undefined,
                supportsToolCalls: this.modelSupportsToolCalls(model)
            }
        } catch {
            return { id: modelId }
        }
    }
}
