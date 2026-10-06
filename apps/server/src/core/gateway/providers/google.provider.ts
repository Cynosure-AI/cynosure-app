import {
  GoogleGenAI,
  type Content,
  type Part,
  type FunctionDeclaration
} from '@google/genai'
import {
  BaseLLMProvider,
  IncompleteModelResponseError,
  type LLMProviderConfig,
  type CompletionRequest,
  type CompletionResponse,
  type StreamChunk,
  type ChatMessage,
  type ContentPart,
  type ToolDefinition,
  type ModelInfo,
  type ModelListType
} from './base.provider.js'
import { ensurePricingLoaded, modelSupportsOutputModality } from '../../model-dev-fetcher.js'

/** Gemini usage; promptTokenCount already includes cachedContentTokenCount. */
function toCompletionUsage(usage: {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
  cachedContentTokenCount?: number
} | undefined): CompletionResponse['usage'] {
  const cacheReadTokens = usage?.cachedContentTokenCount ?? 0
  return {
    promptTokens: usage?.promptTokenCount || 0,
    completionTokens: usage?.candidatesTokenCount || 0,
    totalTokens: usage?.totalTokenCount || 0,
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
  }
}

export class GoogleProvider extends BaseLLMProvider {
  readonly config: LLMProviderConfig
  private client: GoogleGenAI

  constructor(config: LLMProviderConfig) {
    super()
    this.config = { ...config, baseUrl: '' }
    this.client = new GoogleGenAI({ apiKey: config.apiKey || 'not-set' })
  }

  private formatMessages(
    messages: ChatMessage[]
  ): { systemInstruction?: string; contents: Content[] } {
    let systemInstruction: string | undefined
    const contents: Content[] = []

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = typeof msg.content === 'string'
          ? msg.content
          : this.getTextContent(msg.content)
        continue
      }

      if (msg.role === 'tool') {
        const toolParts: Part[] = [
          {
            functionResponse: {
              name: msg.toolCallId || 'unknown',
              response: { result: typeof msg.content === 'string' ? msg.content : this.getTextContent(msg.content) }
            }
          }
        ]
        // Include images as inline data so Gemini can see them
        if (Array.isArray(msg.content)) {
          for (const part of msg.content as ContentPart[]) {
            if (part.type === 'image_url') {
              const url = part.image_url.url
              if (url.startsWith('data:')) {
                const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/)
                if (match) {
                  toolParts.push({ inlineData: { mimeType: match[1], data: match[2] } })
                }
              }
            }
          }
        }
        contents.push({ role: 'user', parts: toolParts })
        continue
      }

      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        const parts: Part[] = []
        const text = typeof msg.content === 'string' ? msg.content : this.getTextContent(msg.content)
        if (text) parts.push({ text })
        for (const tc of msg.toolCalls) {
          const fcPart: Part = {
            functionCall: {
              name: tc.function.name,
              args: JSON.parse(tc.function.arguments || '{}')
            }
          }
          if (tc.thoughtSignature) {
            fcPart.thoughtSignature = tc.thoughtSignature
          }
          parts.push(fcPart)
        }
        contents.push({ role: 'model', parts })
        continue
      }

      const role = msg.role === 'assistant' ? 'model' : 'user'

      if (typeof msg.content === 'string') {
        contents.push({ role, parts: [{ text: msg.content }] })
      } else {
        const parts: Part[] = (msg.content as ContentPart[]).map((part) => {
          if (part.type === 'text') {
            return { text: part.text }
          }
          if (part.type === 'audio_url') {
            const audioUrl = part.audio_url.url
            if (audioUrl.startsWith('data:')) {
              const audioMatch = audioUrl.match(/^data:(audio\/[^;]+);base64,(.+)$/)
              if (audioMatch) {
                return {
                  inlineData: {
                    mimeType: audioMatch[1],
                    data: audioMatch[2]
                  }
                }
              }
            }
            return { text: `[Audio: ${audioUrl}]` }
          }
          const url = part.image_url.url
          if (url.startsWith('data:')) {
            const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/)
            if (match) {
              return {
                inlineData: {
                  mimeType: match[1],
                  data: match[2]
                }
              }
            }
          }
          return { text: `[Image: ${url}]` }
        })
        contents.push({ role, parts })
      }
    }

    return { systemInstruction, contents }
  }

  private assertCompleteFinishReason(reason: string | undefined): void {
    if (!reason || reason === 'STOP') return
    throw new IncompleteModelResponseError(reason.toLowerCase())
  }

  private formatTools(tools: ToolDefinition[]): FunctionDeclaration[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      parametersJsonSchema: t.parameters
    }))
  }

  private async supportsImageOutput(model: string): Promise<boolean> {
    await ensurePricingLoaded().catch(() => { /* best-effort capability metadata */ })
    const supportsImageOutput = modelSupportsOutputModality(this.config.type, model, 'image')
    if (supportsImageOutput != null) return supportsImageOutput

    return /(?:^|[-/])image(?:-|$)|image-preview/.test(model.toLowerCase())
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const start = Date.now()
    const { systemInstruction, contents } = this.formatMessages(request.messages)
    const model = request.model || this.config.defaultModel

    const config: Record<string, unknown> = {
      systemInstruction,
      maxOutputTokens: request.maxTokens,
      tools: request.tools?.length
        ? [{ functionDeclarations: this.formatTools(request.tools) }]
        : undefined
    }
    if (request.temperature != null) config.temperature = request.temperature
    if (await this.supportsImageOutput(model)) {
      config.responseModalities = ['TEXT', 'IMAGE']
    }
    if (request.toolChoice) {
      config.toolConfig = {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: [request.toolChoice.name]
        }
      }
    }

    const response = await this.client.models.generateContent({
      model,
      contents,
      config
    })

    for (const candidate of response.candidates || []) {
      this.assertCompleteFinishReason(candidate.finishReason)
    }

    let content = ''
    const toolCalls: CompletionResponse['toolCalls'] = []
    const images: string[] = []

    for (const candidate of response.candidates || []) {
      for (const part of candidate.content?.parts || []) {
        if (part.thought && part.text) {
          // thought text — skip for content
          continue
        }
        if (part.text) {
          content += part.text
        }
        if (part.inlineData?.data && part.inlineData?.mimeType) {
          images.push(`data:${part.inlineData.mimeType};base64,${part.inlineData.data}`)
        }
        if (part.functionCall) {
          toolCalls.push({
            id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            type: 'function',
            function: {
              name: part.functionCall.name || '',
              arguments: JSON.stringify(part.functionCall.args)
            },
            thoughtSignature: part.thoughtSignature || undefined
          })
        }
      }
    }

    const usage = response.usageMetadata
    return {
      id: `google_${Date.now()}`,
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      images: images.length > 0 ? images : undefined,
      usage: toCompletionUsage(usage),
      model,
      provider: this.config.id,
      latencyMs: Date.now() - start
    }
  }

  async *streamComplete(
    request: CompletionRequest
  ): AsyncIterable<StreamChunk> {
    const { systemInstruction, contents } = this.formatMessages(request.messages)
    const model = request.model || this.config.defaultModel

    const streamConfig: Record<string, unknown> = {
      systemInstruction,
      maxOutputTokens: request.maxTokens,
      tools: request.tools?.length
        ? [{ functionDeclarations: this.formatTools(request.tools) }]
        : undefined
    }
    if (request.temperature != null) streamConfig.temperature = request.temperature
    if (await this.supportsImageOutput(model)) {
      streamConfig.responseModalities = ['TEXT', 'IMAGE']
    }
    if (request.toolChoice) {
      streamConfig.toolConfig = {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: [request.toolChoice.name]
        }
      }
    }

    const stream = await this.client.models.generateContentStream({
      model,
      contents,
      config: streamConfig
    })

    const toolCalls: CompletionResponse['toolCalls'] = []
    let lastUsage: StreamChunk['usage']
    const images: string[] = []
    let finishReason: string | undefined

    for await (const chunk of stream) {
      const chunkFinishReason = chunk.candidates?.[0]?.finishReason
      if (chunkFinishReason) finishReason = chunkFinishReason
      for (const part of chunk.candidates?.[0]?.content?.parts || []) {
        if (part.thought && part.text) {
          yield { thinking: part.text, done: false }
          continue
        }
        if (part.text) {
          yield { content: part.text, done: false }
        }
        if (part.inlineData?.data && part.inlineData?.mimeType) {
          const dataUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
          images.push(dataUrl)
          yield { images: [dataUrl], done: false }
        }
        if (part.functionCall) {
          toolCalls.push({
            id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            type: 'function',
            function: {
              name: part.functionCall.name || '',
              arguments: JSON.stringify(part.functionCall.args)
            },
            thoughtSignature: part.thoughtSignature || undefined
          })
        }
      }

      if (chunk.usageMetadata) {
        lastUsage = toCompletionUsage(chunk.usageMetadata)
      }
    }

    this.assertCompleteFinishReason(finishReason)

    yield {
      done: true,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: lastUsage
    }
  }

  async listModels(type?: ModelListType): Promise<string[]> {
    if (type === 'video' || type === 'image') return []
    try {
      const pager = await this.client.models.list()
      const models: string[] = []
      for await (const model of pager) {
        const methods = getSupportedGenerationMethods(model)
        if (type === 'embedding' && !supportsGenerationMethod(methods, 'embedContent')) {
          continue
        }
        if (type === 'llm' && methods.length > 0 && !supportsGenerationMethod(methods, 'generateContent')) {
          continue
        }
        if (model.name) {
          // API returns "models/gemini-2.5-flash" — strip the prefix
          models.push(model.name.replace(/^models\//, ''))
        }
      }
      return models.sort()
    } catch {
      if (type === 'embedding') {
        return [
          'gemini-embedding-001',
          'text-embedding-004',
        ]
      }
      return [
        'gemini-3.1-flash-lite-preview',
        'gemini-2.5-flash',
        'gemini-2.5-pro',
      ]
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.client.models.generateContent({
        model: this.config.defaultModel,
        contents: 'hi'
      })
      return true
    } catch {
      return false
    }
  }

  async getModelInfo(modelId: string): Promise<ModelInfo> {
    try {
      const model = await this.client.models.get({ model: modelId })
      const limit = (model as unknown as Record<string, unknown>).inputTokenLimit
      return {
        id: modelId,
        contextLength: typeof limit === 'number' ? limit : undefined
      }
    } catch {
      return { id: modelId }
    }
  }
}

function getSupportedGenerationMethods(model: unknown): string[] {
  const raw = model as { supportedGenerationMethods?: unknown; supportedActions?: unknown }
  if (Array.isArray(raw.supportedGenerationMethods)) {
    return raw.supportedGenerationMethods.filter((item): item is string => typeof item === 'string')
  }
  if (Array.isArray(raw.supportedActions)) {
    return raw.supportedActions.filter((item): item is string => typeof item === 'string')
  }
  return []
}

function supportsGenerationMethod(methods: string[], method: string): boolean {
  const wanted = method.toLowerCase()
  return methods.some((m) => m.toLowerCase() === wanted)
}
