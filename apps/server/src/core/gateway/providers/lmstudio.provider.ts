import { OpenAIProvider } from './openai.provider.js'
import type { LLMProviderConfig, ModelInfo, ModelListType } from './base.provider.js'

interface LMStudioModel {
  type: 'llm' | 'embedding'
  key: string
  display_name: string
  architecture?: string | null
  params_string?: string | null
  max_context_length?: number
  loaded_instances?: { id: string; config: { context_length?: number } }[]
}

/**
 * LMStudio provider — uses the OpenAI-compatible API format.
 * Defaults to http://localhost:1234/v1
 * Supports vision models for image input.
 */
export class LMStudioProvider extends OpenAIProvider {
  protected override get defaultBaseUrl(): string { return 'http://localhost:1234/v1' }
  protected override get allowsCustomBaseUrl(): boolean { return true }

  constructor(config: LLMProviderConfig) {
    super({
      ...config,
      apiKey: config.apiKey || 'lm-studio' // LMStudio doesn't require a real key
    })
  }

  /**
   * Use LM Studio's native REST API to list models — returns richer data
   * and lets us filter out embedding models.
   * Endpoint: GET {host}/api/v1/models
   */
  async listModels(type?: ModelListType): Promise<string[]> {
    if (type === 'video') return []
    // Derive the host from the configured baseUrl (strip /v1 suffix)
    const base = (this.config.baseUrl || 'http://localhost:1234/v1').replace(/\/v1\/?$/, '')
    const url = `${base}/api/v1/models`

    try {
      const res = await fetch(url, {
        headers: this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}
      })
      if (!res.ok) {
        // Fall back to OpenAI-compatible endpoint
        return super.listModels(type)
      }
      const data = (await res.json()) as { models: LMStudioModel[] }
      return data.models
        .filter((m) => !type || m.type === type)
        .map((m) => m.key)
        .sort()
    } catch {
      // Fall back to OpenAI-compatible endpoint
      return super.listModels(type)
    }
  }

  /**
   * Fetch model metadata from LM Studio's native API.
   * Returns max_context_length if available.
   */
  async getModelInfo(modelId: string): Promise<ModelInfo> {
    const base = (this.config.baseUrl || 'http://localhost:1234/v1').replace(/\/v1\/?$/, '')
    try {
      const res = await fetch(`${base}/api/v1/models`, {
        headers: this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}
      })
      if (!res.ok) return { id: modelId }
      const data = (await res.json()) as { models: LMStudioModel[] }
      const model = data.models.find(m => m.key === modelId)
      // Prefer the loaded instance's runtime context_length (user-configured, VRAM-limited)
      // over max_context_length (model's theoretical maximum)
      const loadedCtx = model?.loaded_instances?.[0]?.config?.context_length
      const contextLength = loadedCtx || model?.max_context_length || undefined
      return { id: modelId, contextLength }
    } catch {
      return { id: modelId }
    }
  }
}
