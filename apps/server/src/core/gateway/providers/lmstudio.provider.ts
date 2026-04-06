import { OpenAIProvider } from './openai.provider.js'
import type { LLMProviderConfig } from './base.provider.js'

interface LMStudioModel {
  type: 'llm' | 'embedding'
  key: string
  display_name: string
  architecture?: string | null
  params_string?: string | null
}

/**
 * LMStudio provider — uses the OpenAI-compatible API format.
 * Defaults to http://localhost:1234/v1
 * Supports vision models for image input.
 */
export class LMStudioProvider extends OpenAIProvider {
  constructor(config: LLMProviderConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'http://localhost:1234/v1',
      apiKey: config.apiKey || 'lm-studio' // LMStudio doesn't require a real key
    })
  }

  /**
   * Use LM Studio's native REST API to list models — returns richer data
   * and lets us filter out embedding models.
   * Endpoint: GET {host}/api/v1/models
   */
  async listModels(type?: 'llm' | 'embedding'): Promise<string[]> {
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
}
