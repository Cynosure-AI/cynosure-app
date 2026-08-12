import { afterEach, describe, expect, test, vi } from 'vitest'
import type { LLMProviderConfig } from './base.provider.js'
import { OpenRouterProvider } from './openrouter.provider.js'

const config: LLMProviderConfig = {
    id: 'openrouter-test',
    name: 'OpenRouter',
    type: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'test',
    defaultModel: '',
    availableModels: [],
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsVision: true
}

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('OpenRouter reranker model pricing', () => {
    test('adds billing SKUs omitted by the models endpoint', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
            data: [
                {
                    id: 'cohere/rerank-4-fast',
                    architecture: { input_modalities: ['text'], output_modalities: ['rerank'] },
                    pricing: { prompt: '0', completion: '0' }
                },
                {
                    id: 'voyageai/rerank-2.5',
                    architecture: { input_modalities: ['text'], output_modalities: ['rerank'] },
                    pricing: { prompt: '0', completion: '0' }
                }
            ]
        }), { status: 200 })))

        const models = await new OpenRouterProvider(config).listModelItems('reranker')

        expect(models.find((model) => model.id === 'cohere/rerank-4-fast')?.pricing?.skus)
            .toEqual({ per_search: 0.002 })
        expect(models.find((model) => model.id === 'voyageai/rerank-2.5')?.pricing?.skus)
            .toEqual({ input_tokens: 0.00000005 })
    })
})
