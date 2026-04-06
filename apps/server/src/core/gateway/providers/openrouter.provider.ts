import OpenAI from 'openai'
import {
    BaseLLMProvider,
    type LLMProviderConfig,
    type CompletionRequest,
    type CompletionResponse,
    type StreamChunk,
    type ChatMessage,
    type ContentPart,
    type ToolCall
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

    constructor(config: LLMProviderConfig) {
        super()
        this.config = config
        this.client = new OpenAI({
            apiKey: config.apiKey || 'not-set',
            baseURL: config.baseUrl || 'https://openrouter.ai/api/v1',
            defaultHeaders: {
                'HTTP-Referer': 'https://openagent.app',
                'X-OpenRouter-Title': 'OpenAgent'
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
        return messages.map((msg) => {
            if (msg.role === 'system') {
                return {
                    role: 'system' as const,
                    content:
                        typeof msg.content === 'string'
                            ? msg.content
                            : this.getTextContent(msg.content)
                }
            }

            if (msg.role === 'tool') {
                return {
                    role: 'tool' as const,
                    tool_call_id: msg.toolCallId || '',
                    content:
                        typeof msg.content === 'string'
                            ? msg.content
                            : this.getTextContent(msg.content)
                }
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
                return result
            }

            // user message
            if (typeof msg.content === 'string') {
                return { role: 'user' as const, content: msg.content }
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
            return { role: 'user' as const, content: parts }
        })
    }

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
        const start = Date.now()
        const messages = this.formatMessages(request.messages)

        const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
            model: request.model || this.config.defaultModel,
            messages,
            temperature: request.temperature,
            max_tokens: request.maxTokens,
            stream: false
        }

        if (request.tools?.length) {
            params.tools = this.formatToolsForProvider(request.tools) as unknown as OpenAI.Chat.ChatCompletionTool[]
        }

        const response = await this.client.chat.completions.create(params, {
            signal: request.signal
        })

        const choice = response.choices[0]
        const rawContent = choice?.message?.content || ''
        const { text, thinking } = this.separateThinking(rawContent)

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
            thinking: thinking || undefined,
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

        const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
            model: request.model || this.config.defaultModel,
            messages,
            temperature: request.temperature,
            max_tokens: request.maxTokens,
            stream: true,
            stream_options: { include_usage: true }
        }

        if (request.tools?.length) {
            params.tools = this.formatToolsForProvider(request.tools) as unknown as OpenAI.Chat.ChatCompletionTool[]
        }

        const stream = await this.client.chat.completions.create(params, {
            signal: request.signal
        })

        const toolCallAccumulator = new Map<
            number,
            { id: string; name: string; arguments: string }
        >()

        // State machine for streaming <think> tag extraction
        let insideThink = false
        let tagBuffer = ''

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

            // Handle content deltas with <think> tag parsing
            if (delta?.content) {
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
            }

            // Check for finish
            const finishReason = chunk.choices?.[0]?.finish_reason
            if (finishReason) {
                // Flush remaining tag buffer
                if (tagBuffer) {
                    if (insideThink) {
                        yield { thinking: tagBuffer, done: false }
                    } else {
                        yield { content: tagBuffer, done: false }
                    }
                    tagBuffer = ''
                }

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
                    usage: chunk.usage
                        ? {
                            promptTokens: chunk.usage.prompt_tokens,
                            completionTokens: chunk.usage.completion_tokens,
                            totalTokens: chunk.usage.total_tokens
                        }
                        : undefined
                }
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
}
