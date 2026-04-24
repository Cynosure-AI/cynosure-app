import {
  BaseLLMProvider,
  type LLMProviderConfig,
  type CompletionRequest,
  type CompletionResponse,
  type StreamChunk,
  type ModelInfo
} from './providers/base.provider.js'
import { ensurePricingLoaded, getModelContextLength } from '../model-dev-fetcher.js'
import { OpenAIProvider } from './providers/openai.provider.js'
import { AnthropicProvider } from './providers/anthropic.provider.js'
import { GoogleProvider } from './providers/google.provider.js'
import { LMStudioProvider } from './providers/lmstudio.provider.js'
import { GrokProvider } from './providers/grok.provider.js'
import { OllamaProvider } from './providers/ollama.provider.js'
import { OpenRouterProvider } from './providers/openrouter.provider.js'
import { GroqProvider } from './providers/groq.provider.js'
import { MistralProvider } from './providers/mistral.provider.js'

export class LLMGateway {
  private providers = new Map<string, BaseLLMProvider>()
  private lastUsedProviderId: string = ''
  /** Cache model info keyed by "providerId:modelId" — TTL 10 minutes */
  private modelInfoCache = new Map<string, { info: ModelInfo; ts: number }>()

  registerProvider(config: LLMProviderConfig): void {
    const provider = this.createProvider(config)
    this.providers.set(config.id, provider)
    if (!this.lastUsedProviderId) {
      this.lastUsedProviderId = config.id
    }
  }

  private createProvider(config: LLMProviderConfig): BaseLLMProvider {
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
      case 'groq':
        return new GroqProvider(config)
      case 'mistral':
        return new MistralProvider(config)
      default:
        throw new Error(`Unknown provider type: ${config.type}`)
    }
  }

  removeProvider(id: string): void {
    this.providers.delete(id)
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

  async listModels(providerId?: string, type?: 'llm' | 'embedding'): Promise<string[]> {
    const provider = providerId
      ? this.providers.get(providerId)
      : this.getLastUsedProvider()
    if (!provider) throw new Error(`Provider not found`)
    return provider.listModels(type)
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

    // Fallback: if provider didn't return contextLength, try models.dev
    if (!info.contextLength) {
      await ensurePricingLoaded()
      const providerType = provider.config.type
      const ctxLen = getModelContextLength(providerType, modelId)
      if (ctxLen) {
        info.contextLength = ctxLen
      }
    }

    this.modelInfoCache.set(cacheKey, { info, ts: Date.now() })
    return info
  }

  async testConnection(providerId: string): Promise<boolean> {
    const provider = this.providers.get(providerId)
    if (!provider) return false
    return provider.testConnection()
  }
}

// Singleton gateway instance
let gatewayInstance: LLMGateway | null = null

export function getGateway(): LLMGateway {
  if (!gatewayInstance) {
    gatewayInstance = new LLMGateway()
  }
  return gatewayInstance
}
