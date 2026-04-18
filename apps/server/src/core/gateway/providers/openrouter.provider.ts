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
    type ModelInfo
} from './base.provider.js'

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

    /** Whether this provider supports OpenRouter's native reasoning parameter */
    protected get supportsReasoningParam(): boolean { return true }

    constructor(config: LLMProviderConfig) {
        super()
        this.config = config
        this.client = new OpenAI({
            apiKey: config.apiKey || 'not-set',
            baseURL: config.baseUrl || 'https://openrouter.ai/api/v1',
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

        const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & Record<string, unknown> = {
            model: request.model || this.config.defaultModel,
            messages,
            max_tokens: request.maxTokens,
            stream: false
        }
        if (request.temperature != null) params.temperature = request.temperature

        // Send reasoning parameter for OpenRouter native thinking support
        if (this.supportsReasoningParam) {
            params.reasoning = { enabled: request.thinkingEnabled !== false }
        }

        if (request.tools?.length) {
            params.tools = this.formatToolsForProvider(request.tools) as unknown as OpenAI.Chat.ChatCompletionTool[]
        }

        const response = await this.client.chat.completions.create(params as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming, {
            signal: request.signal
        })

        const choice = response.choices[0]
        const msg = choice?.message as unknown as Record<string, unknown> | undefined
        const rawContent = (msg?.content as string) || ''
        const { text, thinking: tagThinking } = this.separateThinking(rawContent)

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

        const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming & Record<string, unknown> = {
            model: request.model || this.config.defaultModel,
            messages,
            max_tokens: request.maxTokens,
            stream: true,
            stream_options: { include_usage: true }
        }
        if (request.temperature != null) params.temperature = request.temperature

        // Send reasoning parameter for OpenRouter native thinking support
        if (this.supportsReasoningParam) {
            params.reasoning = { enabled: request.thinkingEnabled !== false }
        }

        if (request.tools?.length) {
            params.tools = this.formatToolsForProvider(request.tools) as unknown as OpenAI.Chat.ChatCompletionTool[]
        }

        const stream = await this.client.chat.completions.create(params as OpenAI.Chat.ChatCompletionCreateParamsStreaming, {
            signal: request.signal
        })

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

        for await (const chunk of stream) {
            const delta = chunk.choices?.[0]?.delta

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

    async listModels(type?: 'llm' | 'embedding'): Promise<string[]> {
        const baseUrl = (
            this.config.baseUrl || 'https://openrouter.ai/api/v1'
        ).replace(/\/+$/, '')

        const modality = type === 'embedding' ? 'embeddings' : 'text'
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

    async testConnection(): Promise<boolean> {
        try {
            const baseUrl = (
                this.config.baseUrl || 'https://openrouter.ai/api/v1'
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

    /** Returns length of partial tag match at end of text, or 0 if none */
    private findPartialTag(text: string, tag: string): number {
        for (let len = Math.min(tag.length - 1, text.length); len > 0; len--) {
            if (text.endsWith(tag.slice(0, len))) return len
        }
        return 0
    }

    /**
     * Fetch model metadata from OpenRouter's models API.
     * The API returns context_length for each model.
     */
    async getModelInfo(modelId: string): Promise<ModelInfo> {
        const baseUrl = (this.config.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')
        try {
            const res = await fetch(`${baseUrl}/models`, {
                headers: this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}
            })
            if (!res.ok) return { id: modelId }
            const data = (await res.json()) as {
                data: Array<{ id: string; context_length?: number }>
            }
            const model = data.data.find(m => m.id === modelId)
            return {
                id: modelId,
                contextLength: model?.context_length || undefined
            }
        } catch {
            return { id: modelId }
        }
    }
}
