import { OpenAIProvider } from './openai.provider.js'
import type { CompletionRequest } from './base.provider.js'

/**
 * Grok provider (xAI).
 * Uses the OpenAI-compatible API at api.x.ai.
 */
export class GrokProvider extends OpenAIProvider {
    protected get defaultBaseUrl(): string { return 'https://api.x.ai/v1' }

    protected override normalizeReasoningEffort(
        effort: NonNullable<CompletionRequest['reasoningEffort']>,
        model: string
    ): Exclude<NonNullable<CompletionRequest['reasoningEffort']>, 'minimal' | 'max'> {
        if (effort === 'minimal') return 'low'
        if (effort === 'max') {
            return model.toLowerCase().includes('multi-agent') ? 'xhigh' : 'high'
        }
        if (effort === 'xhigh' && !model.toLowerCase().includes('multi-agent')) return 'high'
        return effort
    }
}
