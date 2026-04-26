import { OpenAIProvider } from './openai.provider.js'

/**
 * Grok provider (xAI).
 * Uses the OpenAI-compatible API at api.x.ai.
 */
export class GrokProvider extends OpenAIProvider {
    protected get defaultBaseUrl(): string { return 'https://api.x.ai/v1' }
}
