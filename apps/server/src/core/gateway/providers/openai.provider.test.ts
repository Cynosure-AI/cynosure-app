import { describe, expect, test, vi } from 'vitest'
import type { LLMProviderConfig } from './base.provider.js'
import { OpenAIProvider } from './openai.provider.js'
import { GrokProvider } from './grok.provider.js'

vi.mock('../../model-dev-fetcher.js', () => ({
    ensurePricingLoaded: async () => undefined,
    modelSupportsOutputModality: () => false,
}))

function config(type: LLMProviderConfig['type']): LLMProviderConfig {
    return {
        id: `${type}-test`,
        name: type,
        type,
        baseUrl: '',
        apiKey: 'test',
        defaultModel: 'gpt-test',
        availableModels: [],
        supportsStreaming: true,
        supportsToolCalls: true,
        supportsVision: true,
    }
}

async function requestParams(provider: OpenAIProvider): Promise<Record<string, unknown>> {
    const create = vi.fn().mockResolvedValue({ id: 'resp_1', status: 'completed', output_text: 'done', output: [], model: 'gpt-test' })
    ;(provider as unknown as { client: { responses: { create: typeof create } } }).client = { responses: { create } }
    await provider.complete({ model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }], promptCacheKey: 'conversation-1' })
    return create.mock.calls[0][0]
}

describe('OpenAI prompt cache key', () => {
    test('sends the prompt cache key to OpenAI', async () => {
        expect((await requestParams(new OpenAIProvider(config('openai')))).prompt_cache_key).toBe('conversation-1')
    })

    test('omits it for OpenAI-compatible servers', async () => {
        expect(await requestParams(new GrokProvider(config('grok')))).not.toHaveProperty('prompt_cache_key')
    })
})
