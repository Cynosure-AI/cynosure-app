import Anthropic from '@anthropic-ai/sdk'
import {
  BaseLLMProvider,
  type LLMProviderConfig,
  type CompletionRequest,
  type CompletionResponse,
  type StreamChunk,
  type ChatMessage,
  type ContentPart,
  type ModelInfo
} from './base.provider.js'

export class AnthropicProvider extends BaseLLMProvider {
  readonly config: LLMProviderConfig
  private client: Anthropic
  private static readonly defaultBaseUrl = 'https://api.anthropic.com'

  constructor(config: LLMProviderConfig) {
    super()
    this.config = { ...config, baseUrl: AnthropicProvider.defaultBaseUrl }
    this.client = new Anthropic({
      apiKey: config.apiKey || 'not-set',
      baseURL: AnthropicProvider.defaultBaseUrl
    })
  }

  private formatMessages(
    messages: ChatMessage[]
  ): { system?: string; messages: Anthropic.MessageParam[] } {
    let system: string | undefined
    const formatted: Anthropic.MessageParam[] = []

    for (const msg of messages) {
      if (msg.role === 'system') {
        system = typeof msg.content === 'string' ? msg.content : this.getTextContent(msg.content)
        continue
      }

      if (msg.role === 'tool') {
        const toolResultContent: Anthropic.ToolResultBlockParam['content'] = typeof msg.content === 'string'
          ? msg.content
          : (() => {
            const parts: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = []
            for (const part of msg.content as ContentPart[]) {
              if (part.type === 'text') {
                parts.push({ type: 'text', text: part.text })
              } else if (part.type === 'image_url') {
                const url = part.image_url.url
                if (url.startsWith('data:')) {
                  const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/)
                  if (match) {
                    parts.push({
                      type: 'image',
                      source: {
                        type: 'base64',
                        media_type: match[1] as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                        data: match[2]
                      }
                    })
                  }
                } else {
                  parts.push({ type: 'image', source: { type: 'url', url } })
                }
              }
            }
            return parts.length ? parts : this.getTextContent(msg.content)
          })()
        formatted.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.toolCallId || '',
              content: toolResultContent
            }
          ]
        })
        continue
      }

      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        const content: Anthropic.ContentBlockParam[] = []
        const text = typeof msg.content === 'string' ? msg.content : this.getTextContent(msg.content)
        if (text) {
          content.push({ type: 'text', text })
        }
        for (const tc of msg.toolCalls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments || '{}')
          })
        }
        formatted.push({ role: 'assistant', content })
        continue
      }

      if (typeof msg.content === 'string') {
        formatted.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content
        })
      } else {
        const parts: Anthropic.ContentBlockParam[] = (msg.content as ContentPart[]).map(
          (part) => {
            if (part.type === 'text') {
              return { type: 'text' as const, text: part.text }
            }
            if (part.type === 'audio_url') {
              return { type: 'text' as const, text: '[Audio file attached — audio input is not supported by this provider]' }
            }
            // Convert image URL to base64 source for Anthropic
            const url = part.image_url.url
            if (url.startsWith('data:')) {
              const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/)
              if (match) {
                return {
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: match[1] as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                    data: match[2]
                  }
                }
              }
            }
            return {
              type: 'image' as const,
              source: {
                type: 'url' as const,
                url
              }
            }
          }
        )
        formatted.push({
          role: msg.role as 'user',
          content: parts
        })
      }
    }

    return { system, messages: formatted }
  }

  private formatTools(
    tools: import('./base.provider.js').ToolDefinition[]
  ): Anthropic.Tool[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema
    }))
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const start = Date.now()
    const { system, messages } = this.formatMessages(request.messages)

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: request.model || this.config.defaultModel,
      messages,
      max_tokens: request.maxTokens || 4096,
      stream: false
    }
    if (request.temperature != null) params.temperature = request.temperature
    if (system) params.system = system
    if (request.tools?.length) {
      params.tools = this.formatTools(request.tools)
    }
    if (request.toolChoice) {
      ; (params as unknown as Record<string, unknown>).tool_choice = {
        type: 'tool',
        name: request.toolChoice.name
      }
    }

    const response = await this.client.messages.create(params)

    let content = ''
    let thinking = ''
    const toolCalls: CompletionResponse['toolCalls'] = []
    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text
      } else if (block.type === 'thinking') {
        thinking += (block as unknown as { thinking: string }).thinking
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input)
          }
        })
      }
    }

    return {
      id: response.id,
      content,
      thinking: thinking || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens
      },
      model: response.model,
      provider: this.config.id,
      latencyMs: Date.now() - start
    }
  }

  async *streamComplete(
    request: CompletionRequest
  ): AsyncIterable<StreamChunk> {
    const { system, messages } = this.formatMessages(request.messages)

    const params: Anthropic.MessageCreateParamsStreaming = {
      model: request.model || this.config.defaultModel,
      messages,
      max_tokens: request.maxTokens || 4096,
      stream: true
    }
    if (request.temperature != null) params.temperature = request.temperature
    if (system) params.system = system
    if (request.tools?.length) {
      params.tools = this.formatTools(request.tools)
    }
    if (request.toolChoice) {
      ; (params as unknown as Record<string, unknown>).tool_choice = {
        type: 'tool',
        name: request.toolChoice.name
      }
    }

    const stream = this.client.messages.stream(params)
    const toolCallBuffers = new Map<
      string,
      { id: string; name: string; args: string }
    >()

    let inputTokens = 0
    let outputTokens = 0

    for await (const event of stream) {
      if (event.type === 'message_start') {
        inputTokens = event.message.usage.input_tokens
      }

      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          toolCallBuffers.set(event.content_block.id, {
            id: event.content_block.id,
            name: event.content_block.name,
            args: ''
          })
        }
      }

      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { content: event.delta.text, done: false }
        } else if (event.delta.type === 'thinking_delta') {
          yield { thinking: (event.delta as unknown as { thinking: string }).thinking, done: false }
        } else if (event.delta.type === 'input_json_delta') {
          // Find the current tool call being built
          const lastKey = Array.from(toolCallBuffers.keys()).pop()
          if (lastKey) {
            toolCallBuffers.get(lastKey)!.args += event.delta.partial_json
          }
        }
      }

      if (event.type === 'message_delta') {
        outputTokens = event.usage.output_tokens
      }

      if (event.type === 'message_stop') {
        const toolCalls =
          toolCallBuffers.size > 0
            ? Array.from(toolCallBuffers.values()).map((buf) => ({
              id: buf.id,
              type: 'function' as const,
              function: { name: buf.name, arguments: buf.args }
            }))
            : undefined

        yield {
          done: true,
          toolCalls,
          usage: {
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            totalTokens: inputTokens + outputTokens
          }
        }
      }
    }
  }

  async listModels(_type?: 'llm' | 'embedding'): Promise<string[]> {
    try {
      const response = await this.client.models.list()
      return response.data.map((m) => m.id).sort()
    } catch {
      // Fallback to known models if API doesn't support listing
      return [
        'claude-sonnet-4-20250514',
        'claude-3-5-haiku-20241022',
        'claude-3-5-sonnet-20241022'
      ]
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.client.messages.create({
        model: this.config.defaultModel,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }]
      })
      return true
    } catch {
      return false
    }
  }

  async getModelInfo(modelId: string): Promise<ModelInfo> {
    // Anthropic models list API doesn't expose context_length;
    // use the SDK to retrieve individual model metadata.
    try {
      const model = await this.client.models.retrieve(modelId)
      // The Anthropic SDK model object may not have a typed `context_window`
      // field, but the REST API does return it. Cast for safety.
      const ctx = (model as unknown as Record<string, unknown>).context_window
      if (typeof ctx === 'number') {
        return { id: modelId, contextLength: ctx }
      }
    } catch { /* ignore */ }
    return { id: modelId }
  }
}
