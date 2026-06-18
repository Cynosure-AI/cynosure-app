// Core types for the LLM Gateway

export interface LLMProviderConfig {
  id: string
  name: string
  type: 'openai' | 'anthropic' | 'google' | 'lmstudio' | 'grok' | 'ollama' | 'openrouter' | 'groq' | 'mistral'
  baseUrl: string
  apiKey?: string
  defaultModel: string
  availableModels: string[]
  supportsStreaming: boolean
  supportsToolCalls: boolean
  supportsVision: boolean
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'audio_url'; audio_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  toolCalls?: ToolCall[]
  toolCallId?: string
  metadata?: Record<string, unknown>
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string // JSON string
  }
  /** Gemini thought signature — must be echoed back for thinking models */
  thoughtSignature?: string
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON Schema
  timeout: number
  execute: (params: unknown) => Promise<ToolResult>
}

export interface RegistryToolMetadata {
  /** Stable registry key, when this tool came from the global registry. */
  registryKey: string
  /** Original bare tool name before any collision-safe execution alias was applied. */
  originalName: string
  /** Namespace ID, when this tool came from the global registry. */
  namespaceId: string
  /** Human-readable namespace label, when this tool came from the global registry. */
  namespaceLabel: string
  /** Namespace-level description, when provided by the upstream tool source. */
  namespaceDescription?: string
}

export type RegistryAwareToolDefinition = ToolDefinition & Partial<RegistryToolMetadata>
export type RegisteredToolDefinition = ToolDefinition & RegistryToolMetadata

export interface ToolResult {
  success: boolean
  output: string
  error?: string
  /** Internal-only: additional tools to expose on subsequent LLM rounds. */
  loadedTools?: ToolDefinition[]
  /** Image sources for UI display. AgentExecutor materializes these into artifact URLs before persistence. */
  images?: string[]
  /** Base64 data-URL images for LLM vision (e.g. data:image/png;base64,...) */
  imageDataUrls?: string[]
}

export type ModelListType = 'llm' | 'embedding' | 'image' | 'video' | 'reranker'

export interface ModelPricing {
  /** Cost in $ per token. */
  prompt?: number
  /** Cost in $ per output token. */
  completion?: number
  /** Fixed cost in $ per request. */
  request?: number
  /** Cost in $ per image input/output unit, depending on the model endpoint. */
  image?: number
  /** Provider-specific video or media pricing SKUs. Values are in USD unless the key says cents. */
  skus?: Record<string, number>
}

export interface ModelListItem {
  id: string
  name?: string
  contextLength?: number
  inputModalities?: string[]
  outputModalities?: string[]
  pricing?: ModelPricing
}

export interface ModelInfo {
  id: string
  contextLength?: number
  inputModalities?: string[]
  outputModalities?: string[]
  /** Whether this specific model accepts tool/function declarations. */
  supportsToolCalls?: boolean
  /** Cost in $ per 1M tokens: { input, output } */
  cost?: { input: number; output: number }
  pricing?: ModelPricing
}

export interface VideoGenerationFrameImage {
  type: 'image_url'
  image_url: { url: string }
  frame_type: 'first_frame' | 'last_frame'
}

export interface VideoGenerationReferenceImage {
  type: 'image_url'
  image_url: { url: string }
}

export interface VideoGenerationRequest {
  model: string
  prompt: string
  duration?: number
  resolution?: string
  aspect_ratio?: string
  size?: string
  frame_images?: VideoGenerationFrameImage[]
  input_references?: VideoGenerationReferenceImage[]
  generate_audio?: boolean
  seed?: number
  callback_url?: string
  provider?: Record<string, unknown>
  signal?: AbortSignal
}

export type VideoGenerationStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired'

export interface VideoGenerationJob {
  id: string
  generation_id?: string | null
  polling_url?: string
  status: VideoGenerationStatus | string
  model?: string | null
  unsigned_urls?: string[]
  usage?: {
    cost?: number
    is_byok?: boolean
  }
  error?: string
}

export interface VideoGenerationModelInfo {
  id: string
  canonical_slug?: string
  name?: string
  description?: string
  created?: number
  supported_resolutions?: string[] | null
  supported_aspect_ratios?: string[] | null
  supported_sizes?: string[] | null
  supported_frame_images?: string[] | null
  pricing_skus?: Record<string, string> | null
  allowed_passthrough_parameters?: string[] | null
}

export interface VideoGenerationContent {
  data: ArrayBuffer
  contentType: string
}

export interface CompletionRequest {
  messages: ChatMessage[]
  model?: string
  temperature?: number
  maxTokens?: number
  tools?: ToolDefinition[]
  /** Force a specific tool/function call when the provider supports it. */
  toolChoice?: { type: 'function'; name: string }
  stream?: boolean
  signal?: AbortSignal
  /** Enable reasoning/thinking tokens (default: true) */
  thinkingEnabled?: boolean
}

export interface CompletionResponse {
  id: string
  content: string
  thinking?: string
  toolCalls?: ToolCall[]
  /** Base64 data-URL images generated by the model */
  images?: string[]
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  model: string
  provider: string
  latencyMs: number
}

export interface StreamChunk {
  content?: string
  thinking?: string
  toolCalls?: ToolCall[]
  /** Base64 data-URL images generated by the model */
  images?: string[]
  done: boolean
  usage?: CompletionResponse['usage']
}

export abstract class BaseLLMProvider {
  abstract readonly config: LLMProviderConfig
  abstract complete(request: CompletionRequest): Promise<CompletionResponse>
  abstract streamComplete(
    request: CompletionRequest
  ): AsyncIterable<StreamChunk>
  abstract listModels(type?: ModelListType): Promise<string[]>
  abstract testConnection(): Promise<boolean>

  async listModelItems(type?: ModelListType): Promise<ModelListItem[]> {
    const models = await this.listModels(type)
    return models.map((id) => ({ id }))
  }

  async listVideoModels(): Promise<VideoGenerationModelInfo[]> {
    return []
  }

  async generateVideo(_request: VideoGenerationRequest): Promise<VideoGenerationJob> {
    throw new Error(`${this.config.name} does not support video generation`)
  }

  async getVideoGenerationJob(_jobIdOrUrl: string): Promise<VideoGenerationJob> {
    throw new Error(`${this.config.name} does not support video generation`)
  }

  async getVideoGenerationContent(_jobId: string, _index = 0): Promise<VideoGenerationContent> {
    throw new Error(`${this.config.name} does not support video generation`)
  }

  /**
   * Return metadata for a specific model — most importantly contextLength.
   * Providers override this to query their native API. The default returns
   * only the model id with no context length.
   */
  async getModelInfo(modelId: string): Promise<ModelInfo> {
    return { id: modelId }
  }

  protected formatToolsForProvider(
    tools: ToolDefinition[]
  ): Record<string, unknown>[] {
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }))
  }

  protected getTextContent(content: string | ContentPart[]): string {
    if (typeof content === 'string') return content
    return content
      .filter((p) => p.type === 'text')
      .map((p) => (p as { type: 'text'; text: string }).text)
      .join('')
  }
}
