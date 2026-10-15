import {
  BaseLLMProvider,
  type LLMProviderConfig,
  type CompletionRequest,
  type CompletionResponse,
  type StreamChunk,
  type ModelInfo,
  type ModelListItem,
  type ModelPricing,
  type ModelListType,
  type ImageGenerationModelInfo,
  type ImageGenerationRequest,
  type ImageGenerationResponse,
  type TranscriptionRequest,
  type TranscriptionResponse,
  type VideoGenerationContent,
  type VideoGenerationJob,
  type VideoGenerationModelInfo,
  type VideoGenerationRequest
} from './providers/base.provider.js'
import {
  ensurePricingLoaded,
  getModelMetadata
} from '../model-dev-fetcher.js'
import { OpenAIProvider } from './providers/openai.provider.js'
import { AnthropicProvider } from './providers/anthropic.provider.js'
import { GoogleProvider } from './providers/google.provider.js'
import { LMStudioProvider } from './providers/lmstudio.provider.js'
import { GrokProvider } from './providers/grok.provider.js'
import { OllamaProvider } from './providers/ollama.provider.js'
import { OpenRouterProvider } from './providers/openrouter.provider.js'
import { RequestyProvider } from './providers/requesty.provider.js'
import { GroqProvider } from './providers/groq.provider.js'
import { MistralProvider } from './providers/mistral.provider.js'
import { UnslothProvider } from './providers/unsloth.provider.js'

export class LLMGateway {
  private providers = new Map<string, BaseLLMProvider>()
  private lastUsedProviderId: string = ''
  /** Cache model info keyed by "providerId:modelId" — TTL 10 minutes */
  private modelInfoCache = new Map<string, { info: ModelInfo; ts: number }>()
  /**
   * Raw provider model lists keyed by provider, list kind and type. Every model
   * picker asks every provider on mount, so without this each settings page
   * fans out to the remote /models endpoints. Holds in-flight requests too, so
   * pickers mounting together share one call.
   */
  private modelListCache = new Map<string, ModelListCacheEntry>()

  registerProvider(config: LLMProviderConfig): void {
    const provider = this.createProvider(config)
    this.clearModelListCache(config.id)
    this.providers.set(config.id, provider)
    if (!this.lastUsedProviderId) {
      this.lastUsedProviderId = config.id
    }
  }

  /**
   * Build a provider client without registering it. Used to validate a config
   * before it is saved and to query an unsaved config (for example to list its
   * models while the user is still filling in the form). Throws for unknown types.
   */
  createProvider(config: LLMProviderConfig): BaseLLMProvider {
    switch (config.type) {
      case 'openai':
        return new OpenAIProvider(config)
      case 'anthropic':
        return new AnthropicProvider(config)
      case 'google':
        return new GoogleProvider(config)
      case 'lmstudio':
        return new LMStudioProvider(config)
      case 'grok':
        return new GrokProvider(config)
      case 'ollama':
        return new OllamaProvider(config)
      case 'openrouter':
        return new OpenRouterProvider(config)
      case 'requesty':
        return new RequestyProvider(config)
      case 'groq':
        return new GroqProvider(config)
      case 'mistral':
        return new MistralProvider(config)
      case 'unsloth':
        return new UnslothProvider(config)
      default:
        throw new Error(`Unknown provider type: ${config.type}`)
    }
  }

  removeProvider(id: string): void {
    this.providers.delete(id)
    this.clearModelListCache(id)
    if (this.lastUsedProviderId === id) {
      this.lastUsedProviderId = this.providers.keys().next().value || ''
    }
  }

  setLastUsedProvider(id: string): void {
    if (!this.providers.has(id)) {
      throw new Error(`Provider ${id} not registered`)
    }
    this.lastUsedProviderId = id
  }

  getLastUsedProvider(): BaseLLMProvider {
    const provider = this.providers.get(this.lastUsedProviderId)
    if (!provider) {
      throw new Error('No active provider set')
    }
    return provider
  }

  getProvider(id: string): BaseLLMProvider | undefined {
    return this.providers.get(id)
  }

  getLastUsedProviderId(): string {
    return this.lastUsedProviderId
  }

  getAllProviders(): Map<string, BaseLLMProvider> {
    return this.providers
  }

  async complete(
    request: CompletionRequest,
    providerId?: string
  ): Promise<CompletionResponse> {
    const provider = providerId
      ? this.providers.get(providerId)
      : this.getLastUsedProvider()
    if (!provider) throw new Error(`Provider not found`)
    return provider.complete(request)
  }

  async *streamComplete(
    request: CompletionRequest,
    providerId?: string
  ): AsyncIterable<StreamChunk> {
    const provider = providerId
      ? this.providers.get(providerId)
      : this.getLastUsedProvider()
    if (!provider) throw new Error(`Provider not found`)
    yield* provider.streamComplete(request)
  }

  async listModels(providerId?: string, type?: ModelListType, options: ModelListOptions = {}): Promise<string[]> {
    const provider = providerId
      ? this.providers.get(providerId)
      : this.getLastUsedProvider()
    if (!provider) throw new Error(`Provider not found`)
    if (type === 'decision' && !supportsDecisionModels(provider)) return []
    if (type === 'transcription' && !supportsTranscription(provider)) return []
    return this.cachedModelList(provider, 'ids', type, options, () => provider.listModels(type))
  }

  async listModelItems(providerId?: string, type?: ModelListType, options: ModelListOptions = {}): Promise<ModelListItem[]> {
    const provider = providerId
      ? this.providers.get(providerId)
      : this.getLastUsedProvider()
    if (!provider) throw new Error(`Provider not found`)
    if (type === 'decision' && !supportsDecisionModels(provider)) return []
    if (type === 'transcription' && !supportsTranscription(provider)) return []

    const models = await this.cachedModelList(provider, 'items', type, options, () => provider.listModelItems(type))
    if (isLocalProviderType(provider.config.type)) {
      return models
    }

    // Keep native provider metadata authoritative (OpenRouter is especially
    // rich), then fill missing metadata from the shared models.dev index.
    // Pricing is one quote: mixing its fields with another host's quote can
    // show a rate that neither provider actually charges.
    // All selector types use this path, so favorites and ordinary rows receive
    // the same normalized metadata.
    await ensurePricingLoaded().catch(() => { /* pricing is best-effort */ })
    return models.map((model) => {
      const metadata = getModelMetadata(provider.config.type, model.id)
      if (!metadata) return model

      return {
        ...model,
        contextLength: model.contextLength ?? metadata.contextLength,
        inputModalities: model.inputModalities?.length ? model.inputModalities : metadata.inputModalities,
        outputModalities: model.outputModalities?.length ? model.outputModalities : metadata.outputModalities,
        supportsToolCalls: model.supportsToolCalls ?? metadata.supportsToolCalls,
        pricing: model.pricing ?? (hasProviderPricingCatalog(provider.config.type)
          ? undefined
          : metadata.cost ? pricingFromCost(metadata.cost) : undefined)
      }
    })
  }

  private async cachedModelList<T extends string | ModelListItem>(
    provider: BaseLLMProvider,
    kind: 'ids' | 'items',
    type: ModelListType | undefined,
    options: ModelListOptions,
    load: () => Promise<T[]>
  ): Promise<T[]> {
    // Local servers are fast and list whatever is installed right now, so a
    // freshly pulled model should show up without waiting for a TTL.
    if (isLocalProviderType(provider.config.type)) return load()

    const key = modelListCacheKey(provider.config.id, kind, type)
    const cached = this.modelListCache.get(key)
    if (!options.refresh && cached) {
      if (!('ts' in cached)) return cached.promise as Promise<T[]>
      if (Date.now() - cached.ts < MODEL_LIST_CACHE_TTL_MS) return cached.models as T[]
    }

    const promise = load()
    const entry: ModelListCacheEntry = { promise }
    this.modelListCache.set(key, entry)
    try {
      const models = await promise
      // Skip writing back if the provider was re-registered or removed meanwhile,
      // and do not pin an empty list that may just be a soft provider failure.
      if (this.modelListCache.get(key) === entry) {
        if (models.length) this.modelListCache.set(key, { models, ts: Date.now() })
        else this.modelListCache.delete(key)
      }
      return models
    } catch (err) {
      if (this.modelListCache.get(key) === entry) this.modelListCache.delete(key)
      throw err
    }
  }

  private clearModelListCache(providerId: string): void {
    const prefix = `${providerId}\0`
    for (const key of this.modelListCache.keys()) {
      if (key.startsWith(prefix)) this.modelListCache.delete(key)
    }
  }

  async listVideoModels(providerId?: string): Promise<VideoGenerationModelInfo[]> {
    const provider = providerId
      ? this.providers.get(providerId)
      : this.getLastUsedProvider()
    if (!provider) throw new Error(`Provider not found`)
    return provider.listVideoModels()
  }

  async listImageGenerationModels(providerId?: string): Promise<ImageGenerationModelInfo[]> {
    const provider = providerId ? this.providers.get(providerId) : this.getLastUsedProvider()
    if (!provider) throw new Error('Provider not found')
    return provider.listImageGenerationModels()
  }

  async generateImage(request: ImageGenerationRequest, providerId?: string): Promise<ImageGenerationResponse> {
    const provider = providerId ? this.providers.get(providerId) : this.getLastUsedProvider()
    if (!provider) throw new Error('Provider not found')
    return provider.generateImage(request)
  }

  async generateVideo(
    request: VideoGenerationRequest,
    providerId?: string
  ): Promise<VideoGenerationJob> {
    const provider = providerId
      ? this.providers.get(providerId)
      : this.getLastUsedProvider()
    if (!provider) throw new Error(`Provider not found`)
    return provider.generateVideo(request)
  }

  async getVideoGenerationJob(
    jobIdOrUrl: string,
    providerId?: string
  ): Promise<VideoGenerationJob> {
    const provider = providerId
      ? this.providers.get(providerId)
      : this.getLastUsedProvider()
    if (!provider) throw new Error(`Provider not found`)
    return provider.getVideoGenerationJob(jobIdOrUrl)
  }

  async getVideoGenerationContent(
    jobId: string,
    index = 0,
    providerId?: string
  ): Promise<VideoGenerationContent> {
    const provider = providerId
      ? this.providers.get(providerId)
      : this.getLastUsedProvider()
    if (!provider) throw new Error(`Provider not found`)
    return provider.getVideoGenerationContent(jobId, index)
  }

  async transcribeAudio(
    request: TranscriptionRequest,
    providerId?: string
  ): Promise<TranscriptionResponse> {
    const provider = providerId
      ? this.providers.get(providerId)
      : this.getLastUsedProvider()
    if (!provider) throw new Error(`Provider not found`)
    return provider.transcribeAudio(request)
  }

  /**
   * Get metadata for a specific model (cached for 10 minutes).
   * Returns context length when the provider supports it.
   * Falls back to models.dev data when the provider doesn't expose context length.
   */
  async getModelInfo(modelId: string, providerId?: string): Promise<ModelInfo> {
    const provider = providerId
      ? this.providers.get(providerId)
      : this.getLastUsedProvider()
    if (!provider) throw new Error(`Provider not found`)

    const pid = providerId || this.lastUsedProviderId
    const cacheKey = `${pid}:${modelId}`
    const cached = this.modelInfoCache.get(cacheKey)
    if (cached && Date.now() - cached.ts < 10 * 60 * 1000) {
      return cached.info
    }

    const info = await provider.getModelInfo(modelId)

    // The model-list endpoint is often richer than the provider's single-model
    // endpoint (some OpenAI-compatible APIs only return an id from /models/:id).
    // Keep getModelInfo authoritative by filling gaps from that same list data.
    if (
      !info.contextLength ||
      !info.inputModalities?.length ||
      !info.outputModalities?.length ||
      !info.pricing
    ) {
      try {
        let listedModel: ModelListItem | undefined
        const listTypes: Array<ModelListType | undefined> = [
          undefined,
          'image',
          'video',
          'transcription'
        ]
        for (const type of listTypes) {
          const models = await this.cachedModelList(provider, 'items', type, {}, () => provider.listModelItems(type))
          listedModel = models.find((model) => model.id === modelId)
          if (listedModel) break
        }
        if (listedModel) {
          info.contextLength ||= listedModel.contextLength
          if (!info.inputModalities?.length && listedModel.inputModalities?.length) {
            info.inputModalities = listedModel.inputModalities
          }
          if (!info.outputModalities?.length && listedModel.outputModalities?.length) {
            info.outputModalities = listedModel.outputModalities
          }
          if (listedModel.pricing) {
            info.pricing = {
              ...listedModel.pricing,
              ...info.pricing,
              skus: {
                ...listedModel.pricing.skus,
                ...info.pricing?.skus
              }
            }
          }
        }
      } catch {
        // Best effort; models.dev below may still provide the missing fields.
      }
    }

    await ensurePricingLoaded().catch(() => { /* metadata is best-effort */ })
    const metadata = getModelMetadata(provider.config.type, modelId)
    info.contextLength ??= metadata?.contextLength
    if (!info.inputModalities?.length) info.inputModalities = metadata?.inputModalities
    if (!info.outputModalities?.length) info.outputModalities = metadata?.outputModalities
    info.supportsToolCalls ??= metadata?.supportsToolCalls
    if (!info.pricing && !hasProviderPricingCatalog(provider.config.type)) {
      info.pricing = metadata?.cost ? pricingFromCost(metadata.cost) : undefined
    }

    if (info.pricing && (info.pricing.prompt != null || info.pricing.completion != null)) {
      info.cost = {
        input: (info.pricing.prompt ?? 0) * 1_000_000,
        output: (info.pricing.completion ?? 0) * 1_000_000
      }
    } else if (!hasProviderPricingCatalog(provider.config.type)) {
      info.cost ??= metadata?.cost
    }

    // Do not turn a transient upstream/models.dev failure into ten minutes of
    // empty metadata. Meaningful partial information is still safe to cache.
    if (hasUsefulModelInfo(info)) {
      this.modelInfoCache.set(cacheKey, { info, ts: Date.now() })
    }
    return info
  }

  async modelSupportsToolCalls(modelId: string, providerId?: string): Promise<boolean> {
    const provider = providerId
      ? this.providers.get(providerId)
      : this.getLastUsedProvider()
    if (!provider) throw new Error(`Provider not found`)
    if (!provider.config.supportsToolCalls) return false

    try {
      const info = await this.getModelInfo(modelId, providerId)
      if (typeof info.supportsToolCalls === 'boolean') return info.supportsToolCalls
    } catch {
      // Fall back to provider-level capability below.
    }

    return provider.config.supportsToolCalls
  }

  async testConnection(providerId: string): Promise<boolean> {
    const provider = this.providers.get(providerId)
    if (!provider) return false
    return provider.testConnection()
  }
}

function hasUsefulModelInfo(info: ModelInfo): boolean {
  return Boolean(
    info.contextLength ||
    info.inputModalities?.length ||
    info.outputModalities?.length ||
    typeof info.supportsToolCalls === 'boolean' ||
    info.cost ||
    info.pricing
  )
}

function pricingFromCost(cost: NonNullable<ReturnType<typeof getModelMetadata>>['cost']): ModelPricing {
  if (!cost) return {}
  return {
    prompt: cost.input / 1_000_000,
    completion: cost.output / 1_000_000,
    ...(cost.cacheRead != null ? { inputCacheRead: cost.cacheRead / 1_000_000 } : {}),
    ...(cost.cacheWrite != null ? { inputCacheWrite: cost.cacheWrite / 1_000_000 } : {}),
    ...(cost.reasoning != null ? { internalReasoning: cost.reasoning / 1_000_000 } : {}),
    ...((cost.inputAudio != null || cost.outputAudio != null) ? {
      skus: {
        ...(cost.inputAudio != null ? { input_audio_tokens: cost.inputAudio / 1_000_000 } : {}),
        ...(cost.outputAudio != null ? { output_audio_tokens: cost.outputAudio / 1_000_000 } : {})
      }
    } : {}),
    ...(cost.tiers?.length ? {
      tiers: cost.tiers.map((tier) => ({
        prompt: tier.input / 1_000_000,
        completion: tier.output / 1_000_000,
        ...(tier.cacheRead != null ? { inputCacheRead: tier.cacheRead / 1_000_000 } : {}),
        ...(tier.cacheWrite != null ? { inputCacheWrite: tier.cacheWrite / 1_000_000 } : {}),
        ...(tier.minInputTokens != null ? { minPromptTokens: tier.minInputTokens } : {})
      }))
    } : {})
  }
}

/** Decision models (typed judgments instead of text) are an OpenRouter catalog. */
/** Matches the TTL OpenRouter and Requesty already use for their own model caches. */
const MODEL_LIST_CACHE_TTL_MS = 10 * 60 * 1000

export interface ModelListOptions {
  /** Bypass the cached list, for example when the user presses refresh. */
  refresh?: boolean
}

type ModelListCacheEntry =
  | { promise: Promise<Array<string | ModelListItem>> }
  | { models: Array<string | ModelListItem>; ts: number }

function modelListCacheKey(providerId: string, kind: 'ids' | 'items', type: ModelListType | undefined): string {
  return `${providerId}\0${kind}\0${type ?? ''}`
}

function isLocalProviderType(type: LLMProviderConfig['type']): boolean {
  return type === 'ollama' || type === 'lmstudio' || type === 'unsloth'
}

function supportsDecisionModels(provider: BaseLLMProvider): boolean {
  return provider.config.type === 'openrouter'
}

/**
 * Hosts with a working /audio/transcriptions client. Other providers would
 * otherwise list their chat models for the transcription picker.
 */
function supportsTranscription(provider: BaseLLMProvider): boolean {
  const type = provider.config.type
  return type === 'openrouter' || type === 'groq' || type === 'requesty'
}

function hasProviderPricingCatalog(type: LLMProviderConfig['type']): boolean {
  return type === 'openrouter' || type === 'requesty'
}

// Singleton gateway instance
let gatewayInstance: LLMGateway | null = null

export function getGateway(): LLMGateway {
  if (!gatewayInstance) {
    gatewayInstance = new LLMGateway()
  }
  return gatewayInstance
}
