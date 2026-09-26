// Core types for the LLM Gateway

export interface LLMProviderConfig {
  id: string
  name: string
  type: 'openai' | 'anthropic' | 'google' | 'lmstudio' | 'grok' | 'ollama' | 'openrouter' | 'requesty' | 'groq' | 'mistral'
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

/**
 * Server-declared MCP behavior hints. These describe likely side effects but
 * are not trusted authorization decisions; explicit user policy still wins.
 */
export interface ToolBehaviorAnnotations {
  /** Human-readable title supplied by the tool provider. */
  title?: string
  /** True when the tool does not modify its environment. Defaults to false in MCP. */
  readOnlyHint?: boolean
  /** True when a mutating tool may perform destructive updates. Defaults to true in MCP. */
  destructiveHint?: boolean
  /** True when repeating a mutating call has no additional effect. Defaults to false in MCP. */
  idempotentHint?: boolean
  /** True when the tool may interact with external entities. Defaults to true in MCP. */
  openWorldHint?: boolean
}

/** Audience and presentation hints attached to MCP result content. */
export interface ToolContentAnnotations {
  audience?: Array<'user' | 'assistant'>
  priority?: number
  lastModified?: string
}

export interface ToolIcon {
  src: string
  mimeType?: string
  sizes?: string[]
  theme?: 'light' | 'dark'
}

export type ToolResultContent =
  | { type: 'text'; text: string; annotations?: ToolContentAnnotations; _meta?: Record<string, unknown> }
  | { type: 'image'; data: string; mimeType: string; annotations?: ToolContentAnnotations; _meta?: Record<string, unknown> }
  | { type: 'audio'; data: string; mimeType: string; annotations?: ToolContentAnnotations; _meta?: Record<string, unknown> }
  | {
      type: 'resource_link'
      uri: string
      name: string
      title?: string
      description?: string
      mimeType?: string
      size?: number
      icons?: ToolIcon[]
      annotations?: ToolContentAnnotations
      _meta?: Record<string, unknown>
    }
  | {
      type: 'resource'
      resource: {
        uri: string
        mimeType?: string
        text?: string
        blob?: string
        annotations?: ToolContentAnnotations
        _meta?: Record<string, unknown>
      }
      annotations?: ToolContentAnnotations
      _meta?: Record<string, unknown>
    }

export interface ToolDefinition {
  name: string
  /** Human-readable display name supplied independently of the callable name. */
  title?: string
  description: string
  parameters: Record<string, unknown> // JSON Schema
  /** MCP schema for structuredContent returned by this tool. */
  outputSchema?: Record<string, unknown>
  icons?: ToolIcon[]
  /** Opaque provider metadata. It must not be treated as trusted policy. */
  providerMetadata?: Record<string, unknown>
  timeout: number
  /** Advisory behavior metadata declared by the tool provider. */
  annotations?: ToolBehaviorAnnotations
  /** Execution scheduling hints. Unknown tools are treated as mutating and run serially. */
  execution?: {
    readOnly: boolean
  }
  execute: (params: unknown, signal?: AbortSignal) => Promise<ToolResult>
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
  /** Canonical, de-duplicated representation passed to the model and shown in transcript. */
  output: string
  error?: string
  /** Original MCP content blocks, retained for rich clients and content annotations. */
  content?: ToolResultContent[]
  /** Original machine-readable result. Exact JSON duplicates in content are omitted from output. */
  structuredContent?: unknown
  /** Opaque MCP result metadata. It is retained but not sent to the model. */
  providerMetadata?: Record<string, unknown>
  /** Internal-only: additional tools to expose on subsequent LLM rounds. */
  loadedTools?: ToolDefinition[]
  /** Image sources for UI display. AgentExecutor materializes these into artifact URLs before persistence. */
  images?: string[]
  /** Base64 data-URL images for LLM vision (e.g. data:image/png;base64,...) */
  imageDataUrls?: string[]
  /** Base64 data-URL audio returned by a tool. */
  audioDataUrls?: string[]
}

export type ModelListType = 'llm' | 'embedding' | 'image' | 'video' | 'reranker' | 'transcription'

export interface ModelPricing {
  /** Cost in $ per token. */
  prompt?: number
  /** Cost in $ per output token. */
  completion?: number
  /** Fixed cost in $ per request. */
  request?: number
  /** Cost in $ per image input/output unit, depending on the model endpoint. */
  image?: number
  /** Cost in $ per audio unit, depending on the model endpoint. */
  audio?: number
  /** Cost in $ per web search operation. */
  webSearch?: number
  /** Cost in $ per internal reasoning token. */
  internalReasoning?: number
  /** Cost in $ per cached input token read. */
  inputCacheRead?: number
  /** Cost in $ per cached input token write. */
  inputCacheWrite?: number
  /** Provider-specific endpoint pricing SKUs. Values are in USD unless the key says cents. */
  skus?: Record<string, number>
  /** Alternate token rates selected by context size or another provider rule. */
  tiers?: ModelPricingTier[]
}

export interface ModelPricingTier {
  prompt?: number
  completion?: number
  inputCacheRead?: number
  inputCacheWrite?: number
  minPromptTokens?: number
  utcStart?: number
  utcEnd?: number
}

export interface ModelListItem {
  id: string
  name?: string
  contextLength?: number
  inputModalities?: string[]
  outputModalities?: string[]
  supportsToolCalls?: boolean
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
  supported_durations?: number[] | null
  supported_resolutions?: string[] | null
  supported_aspect_ratios?: string[] | null
  supported_sizes?: string[] | null
  supported_frame_images?: string[] | null
  pricing_skus?: Record<string, string> | null
  allowed_passthrough_parameters?: string[] | null
}

export interface ImageGenerationModelInfo {
  id: string
  supported_parameters?: Record<string, { type: string; values?: string[]; min?: number; max?: number }>
}

export interface ImageGenerationRequest {
  model: string
  prompt: string
  n?: number
  resolution?: string
  aspect_ratio?: string
  input_references?: VideoGenerationReferenceImage[]
  signal?: AbortSignal
}

export interface ImageGenerationResponse {
  data: Array<{ b64_json: string; media_type?: string }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

export interface VideoGenerationContent {
  data: ArrayBuffer
  contentType: string
}

export interface TranscriptionRequest {
  model: string
  inputAudio: {
    data: string
    format?: string
  }
  language?: string
  temperature?: number
  provider?: Record<string, unknown>
  signal?: AbortSignal
}

export interface TranscriptionResponse {
  text: string
  usage?: {
    cost?: number
    input_tokens?: number
    output_tokens?: number
    seconds?: number
    total_tokens?: number
  }
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
  /** Amount of reasoning work requested when thinking is enabled. */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

/**
 * Raised when a provider returns a terminal response that is not a complete
 * generation (for example a token limit or content filter). Callers should not
 * present partial output as a successful assistant turn.
 */
export class IncompleteModelResponseError extends Error {
  readonly reason: string

  constructor(reason: string, detail?: string) {
    super(detail ? `Model response incomplete (${reason}): ${detail}` : `Model response incomplete (${reason}).`)
    this.name = 'IncompleteModelResponseError'
    this.reason = reason
  }
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

  async listImageGenerationModels(): Promise<ImageGenerationModelInfo[]> {
    return []
  }

  async generateImage(_request: ImageGenerationRequest): Promise<ImageGenerationResponse> {
    throw new Error(`${this.config.name} does not support dedicated image generation`)
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

  async transcribeAudio(_request: TranscriptionRequest): Promise<TranscriptionResponse> {
    throw new Error(`${this.config.name} does not support audio transcription`)
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
