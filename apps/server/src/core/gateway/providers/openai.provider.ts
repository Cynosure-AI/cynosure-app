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

export class OpenAIProvider extends BaseLLMProvider {
  readonly config: LLMProviderConfig
  protected client: OpenAI
  protected get defaultBaseUrl(): string { return 'https://api.openai.com/v1' }
  protected get allowsCustomBaseUrl(): boolean { return false }

  constructor(config: LLMProviderConfig) {
    super()
    const baseUrl = this.allowsCustomBaseUrl
      ? config.baseUrl || this.defaultBaseUrl
      : this.defaultBaseUrl
    this.config = { ...config, baseUrl }
    this.client = new OpenAI({
      apiKey: config.apiKey || 'not-set',
      baseURL: baseUrl
    })
  }

  /** Extract <think>...</think> blocks from content (Qwen, DeepSeek, etc.) */
  protected separateThinking(content: string): { text: string; thinking: string } {
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

  // ═══════════════════════════════════════════════════════════════════════════
  //  Responses API
  // ═══════════════════════════════════════════════════════════════════════════

  /** Convert internal ChatMessage[] → Responses API input format */
  private formatMessagesForResponses(
    messages: ChatMessage[]
  ): { instructions: string | undefined; input: unknown[] } {
    let instructions: string | undefined
    const input: unknown[] = []

    for (const msg of messages) {
      if (msg.role === 'system') {
        instructions = typeof msg.content === 'string'
          ? msg.content
          : this.getTextContent(msg.content)
        continue
      }

      if (msg.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: msg.toolCallId || '',
          output: typeof msg.content === 'string'
            ? msg.content
            : this.getTextContent(msg.content)
        })
        // If the tool returned images, wrap them in a user message so the LLM can see them
        if (Array.isArray(msg.content)) {
          const imageParts = (msg.content as ContentPart[])
            .filter(p => p.type === 'image_url')
            .map(p => ({ type: 'input_image' as const, image_url: (p as { type: 'image_url'; image_url: { url: string } }).image_url.url }))
          if (imageParts.length) {
            input.push({
              role: 'user' as const,
              content: [
                { type: 'input_text' as const, text: 'Here is the visual output from the tool:' },
                ...imageParts
              ]
            })
          }
        }
        continue
      }

      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        const text = typeof msg.content === 'string'
          ? msg.content
          : this.getTextContent(msg.content)
        if (text) {
          input.push({ role: 'assistant', content: text })
        }
        for (const tc of msg.toolCalls) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments
          })
        }
        continue
      }

      // Regular user / assistant message
      if (typeof msg.content === 'string') {
        input.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content
        })
      } else {
        // Multimodal content
        const parts = (msg.content as ContentPart[]).map((part) => {
          if (part.type === 'text') {
            return { type: 'input_text' as const, text: part.text }
          }
          if (part.type === 'audio_url') {
            const url = part.audio_url.url
            const audioMatch = url.match(/^data:audio\/([^;]+);base64,(.+)$/)
            if (audioMatch) {
              return { type: 'input_audio' as const, input_audio: { data: audioMatch[2], format: audioMatch[1] } }
            }
            return { type: 'input_text' as const, text: `[Audio: ${url}]` }
          }
          return { type: 'input_image' as const, image_url: part.image_url.url }
        })
        input.push({ role: msg.role as 'user', content: parts })
      }
    }

    return { instructions, input }
  }

  /** Build the tools array for the Responses API (function tools + image_generation where supported) */
  private formatToolsForResponses(
    tools?: import('./base.provider.js').ToolDefinition[]
  ): unknown[] | undefined {
    if (!tools?.length) return undefined
    const formatted: unknown[] = tools.map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: false
    }))
    // Include built-in image generation for providers that support it
    if (this.config.type === 'openai' || this.config.type === 'grok') {
      formatted.push({ type: 'image_generation' })
    }
    return formatted
  }

  protected async completeViaResponses(request: CompletionRequest): Promise<CompletionResponse> {
    const start = Date.now()
    const { instructions, input } = this.formatMessagesForResponses(request.messages)

    const params: Record<string, unknown> = {
      model: request.model || this.config.defaultModel,
      input,
      max_output_tokens: request.maxTokens,
      store: false,
      stream: false
    }
    if (request.temperature != null) params.temperature = request.temperature
    if (instructions) params.instructions = instructions
    const tools = this.formatToolsForResponses(request.tools)
    if (tools) params.tools = tools
    if (request.thinkingEnabled) {
      params.reasoning = { effort: 'medium', summary: 'auto' }
    }

    const response = await (this.client.responses.create as Function)(params, {
      signal: request.signal
    }) as {
      id: string
      output_text: string
      output: Array<{ type: string; call_id?: string; name?: string; arguments?: string; result?: string | null; id?: string }>
      model: string
      usage?: { input_tokens: number; output_tokens: number; total_tokens: number }
    }

    const content = response.output_text || ''
    const toolCalls: ToolCall[] = []
    const images: string[] = []

    for (const item of response.output) {
      if (item.type === 'function_call' && item.call_id) {
        toolCalls.push({
          id: item.call_id,
          type: 'function',
          function: {
            name: item.name || '',
            arguments: item.arguments || '{}'
          }
        })
      } else if (item.type === 'image_generation_call' && item.result) {
        images.push(`data:image/png;base64,${item.result}`)
      }
    }

    const { text, thinking } = this.separateThinking(content)

    return {
      id: response.id,
      content: text,
      thinking: thinking || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      images: images.length > 0 ? images : undefined,
      usage: {
        promptTokens: response.usage?.input_tokens || 0,
        completionTokens: response.usage?.output_tokens || 0,
        totalTokens: response.usage?.total_tokens || 0
      },
      model: response.model || request.model || this.config.defaultModel,
      provider: this.config.id,
      latencyMs: Date.now() - start
    }
  }

  protected async *streamCompleteViaResponses(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const { instructions, input } = this.formatMessagesForResponses(request.messages)

    const params: Record<string, unknown> = {
      model: request.model || this.config.defaultModel,
      input,
      max_output_tokens: request.maxTokens,
      store: false
    }
    if (request.temperature != null) params.temperature = request.temperature
    if (instructions) params.instructions = instructions
    const tools = this.formatToolsForResponses(request.tools)
    if (tools) params.tools = tools
    if (request.thinkingEnabled) {
      params.reasoning = { effort: 'medium', summary: 'auto' }
    }

    const stream = (this.client.responses as unknown as {
      stream(params: unknown, opts?: unknown): AsyncIterable<{
        type: string
        delta?: string
        item_id?: string
        item?: { type: string; call_id?: string; name?: string; arguments?: string; result?: string | null; id?: string }
        response?: {
          usage?: { input_tokens: number; output_tokens: number; total_tokens: number }
          error?: { message?: string }
        }
      }>
    }).stream(params, { signal: request.signal })

    const completedToolCalls: ToolCall[] = []

    // State machine for streaming <think> tag extraction
    let insideThink = false
    let tagBuffer = ''

    for await (const event of stream) {
      switch (event.type) {
        case 'response.output_text.delta': {
          // Parse for <think> tags (same logic as Completions path)
          let raw = tagBuffer + (event.delta || '')
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
          break
        }

        case 'response.reasoning_text.delta':
        case 'response.reasoning_summary_text.delta': {
          if (event.delta) yield { thinking: event.delta, done: false }
          break
        }

        case 'response.output_item.done': {
          const item = event.item
          if (!item) break
          if (item.type === 'function_call' && item.call_id) {
            completedToolCalls.push({
              id: item.call_id,
              type: 'function',
              function: {
                name: item.name || '',
                arguments: item.arguments || '{}'
              }
            })
          } else if (item.type === 'image_generation_call' && item.result) {
            yield { images: [`data:image/png;base64,${item.result}`], done: false }
          }
          break
        }

        case 'response.completed': {
          // Flush remaining tag buffer
          if (tagBuffer) {
            if (insideThink) {
              yield { thinking: tagBuffer, done: false }
            } else {
              yield { content: tagBuffer, done: false }
            }
            tagBuffer = ''
          }

          const usage = event.response?.usage
          yield {
            done: true,
            toolCalls: completedToolCalls.length > 0 ? completedToolCalls : undefined,
            usage: usage
              ? {
                promptTokens: usage.input_tokens,
                completionTokens: usage.output_tokens,
                totalTokens: usage.total_tokens
              }
              : undefined
          }
          break
        }

        case 'response.failed': {
          const errMsg = event.response?.error?.message || 'Response generation failed'
          throw new Error(errMsg)
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════════════════════════════════════

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    return this.completeViaResponses(request)
  }

  async *streamComplete(request: CompletionRequest): AsyncIterable<StreamChunk> {
    yield* this.streamCompleteViaResponses(request)
  }

  async listModels(_type?: 'llm' | 'embedding'): Promise<string[]> {
    const models = await this.client.models.list()
    return models.data.map((m) => m.id).sort()
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.client.models.list()
      return true
    } catch {
      return false
    }
  }

  /**
   * Retrieve model metadata from the OpenAI-compatible API.
   * Some providers (OpenAI, compatible APIs) may not expose context_length
   * in the model object — this is a best-effort attempt.
   */
  async getModelInfo(modelId: string): Promise<ModelInfo> {
    try {
      const model = await this.client.models.retrieve(modelId)
      // The OpenAI SDK doesn't type context_length, but some compatible
      // APIs (and OpenAI itself for newer models) include it.
      const raw = model as unknown as Record<string, unknown>
      const ctx = raw.context_length ?? raw.context_window
      return {
        id: modelId,
        contextLength: typeof ctx === 'number' ? ctx : undefined
      }
    } catch {
      return { id: modelId }
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
