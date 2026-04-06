import { OpenAIProvider } from './openai.provider.js'
import type { LLMProviderConfig } from './base.provider.js'

/**
 * Grok provider (xAI).
 * Uses the OpenAI-compatible API at api.x.ai.
 */
export class GrokProvider extends OpenAIProvider {
    constructor(config: LLMProviderConfig) {
        super({
            ...config,
            baseUrl: config.baseUrl || 'https://api.x.ai/v1'
        })
    }
}
