import {
  BaseLLMProvider,
  type LLMProviderConfig,
  type CompletionRequest,
  type CompletionResponse,
  type StreamChunk
} from './providers/base.provider.js'
import { OpenAIProvider } from './providers/openai.provider.js'
import { AnthropicProvider } from './providers/anthropic.provider.js'
import { GeminiProvider } from './providers/gemini.provider.js'
import { LMStudioProvider } from './providers/lmstudio.provider.js'
import { GrokProvider } from './providers/grok.provider.js'
import { OllamaProvider } from './providers/ollama.provider.js'
import { OpenRouterProvider } from './providers/openrouter.provider.js'
import { GroqProvider } from './providers/groq.provider.js'

export class LLMGateway {
  private providers = new Map<string, BaseLLMProvider>()
  private activeProviderId: string = ''

  registerProvider(config: LLMProviderConfig): void {
    const provider = this.createProvider(config)
    this.providers.set(config.id, provider)
    if (!this.activeProviderId) {
      this.activeProviderId = config.id
    }
  }

  private createProvider(config: LLMProviderConfig): BaseLLMProvider {
    switch (config.type) {
      case 'openai':
        return new OpenAIProvider(config)
      case 'anthropic':
        return new AnthropicProvider(config)
      case 'gemini':
        return new GeminiProvider(config)
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
      default:
        throw new Error(`Unknown provider type: ${config.type}`)
    }
  }

  removeProvider(id: string): void {
    this.providers.delete(id)
    if (this.activeProviderId === id) {
      this.activeProviderId = this.providers.keys().next().value || ''
    }
  }

  setActiveProvider(id: string): void {
    if (!this.providers.has(id)) {
      throw new Error(`Provider ${id} not registered`)
    }
    this.activeProviderId = id
  }

  getActiveProvider(): BaseLLMProvider {
    const provider = this.providers.get(this.activeProviderId)
    if (!provider) {
      throw new Error('No active provider set')
    }
    return provider
  }

  getProvider(id: string): BaseLLMProvider | undefined {
    return this.providers.get(id)
  }

  getActiveProviderId(): string {
    return this.activeProviderId
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
      : this.getActiveProvider()
    if (!provider) throw new Error(`Provider not found`)
    return provider.complete(request)
  }

  async *streamComplete(
    request: CompletionRequest,
    providerId?: string
  ): AsyncIterable<StreamChunk> {
    const provider = providerId
      ? this.providers.get(providerId)
      : this.getActiveProvider()
    if (!provider) throw new Error(`Provider not found`)
    yield* provider.streamComplete(request)
  }

  async listModels(providerId?: string, type?: 'llm' | 'embedding'): Promise<string[]> {
    const provider = providerId
      ? this.providers.get(providerId)
      : this.getActiveProvider()
    if (!provider) throw new Error(`Provider not found`)
    return provider.listModels(type)
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
