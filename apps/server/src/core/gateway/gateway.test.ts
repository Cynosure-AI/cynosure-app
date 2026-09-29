import { beforeEach, describe, expect, test, vi } from 'vitest'

const metadataMocks = vi.hoisted(() => ({
    ensurePricingLoaded: vi.fn().mockResolvedValue(undefined),
    getModelMetadata: vi.fn(),
}))

vi.mock('../model-dev-fetcher.js', () => metadataMocks)

import { LLMGateway } from './gateway.js'
import type { BaseLLMProvider, ModelListItem } from './providers/base.provider.js'
import { RequestyProvider } from './providers/requesty.provider.js'

describe('LLMGateway provider registration', () => {
    test('creates the dedicated Requesty adapter', () => {
        const gateway = new LLMGateway()
        gateway.registerProvider({
            id: 'requesty-1',
            name: 'Requesty',
            type: 'requesty',
            baseUrl: '',
            apiKey: 'test-key',
            defaultModel: 'openai/gpt-4o',
            availableModels: [],
            supportsStreaming: true,
            supportsToolCalls: true,
            supportsVision: true,
        })

        expect(gateway.getProvider('requesty-1')).toBeInstanceOf(RequestyProvider)
        expect(gateway.getProvider('requesty-1')?.config.baseUrl).toBe('https://router.requesty.ai/v1')
    })
})

describe('LLMGateway model metadata enrichment', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        metadataMocks.getModelMetadata.mockReturnValue({
            cost: { input: 2.5, output: 10, cacheRead: 0.25 },
            contextLength: 128_000,
            inputModalities: ['text', 'image'],
            outputModalities: ['text'],
            supportsToolCalls: true,
        })
    })

    test('enriches ordinary OpenAI model lists and preserves native pricing', async () => {
        const gateway = new LLMGateway()
        const models: ModelListItem[] = [
            { id: 'gpt-test' },
            { id: 'gpt-native', pricing: { prompt: 0.000001, completion: 0.000004 } },
        ]
        const provider = {
            config: { id: 'provider-1', type: 'openai' },
            listModelItems: vi.fn().mockResolvedValue(models),
        } as unknown as BaseLLMProvider
        gateway.getAllProviders().set('provider-1', provider)

        const result = await gateway.listModelItems('provider-1', 'llm')

        expect(result[0]).toMatchObject({
            id: 'gpt-test',
            contextLength: 128_000,
            inputModalities: ['text', 'image'],
            outputModalities: ['text'],
            supportsToolCalls: true,
            pricing: { prompt: 0.0000025, completion: 0.00001, inputCacheRead: 0.00000025 },
        })
        expect(result[1].pricing).toMatchObject({ prompt: 0.000001, completion: 0.000004 })
        expect(metadataMocks.getModelMetadata).toHaveBeenCalledWith('openai', 'gpt-test')
    })

    test('does not mix OpenRouter pricing with an upstream models.dev quote', async () => {
        const gateway = new LLMGateway()
        const provider = {
            config: { id: 'openrouter-1', type: 'openrouter' },
            listModelItems: vi.fn().mockResolvedValue([
                { id: 'deepseek/deepseek-v4.1-flash', pricing: { prompt: 0.00000015, completion: 0.0000006 } },
                { id: 'partial-price', pricing: { prompt: 0.00000015 } },
                { id: 'no-native-price' },
            ]),
        } as unknown as BaseLLMProvider
        gateway.getAllProviders().set('openrouter-1', provider)

        const result = await gateway.listModelItems('openrouter-1', 'llm')

        expect(result[0].pricing).toEqual({ prompt: 0.00000015, completion: 0.0000006 })
        expect(result[1].pricing).toEqual({ prompt: 0.00000015 })
        expect(result[2].pricing).toBeUndefined()
    })

    test('returns the same normalized pricing from single-model metadata', async () => {
        const gateway = new LLMGateway()
        const provider = {
            config: { id: 'provider-1', type: 'openai' },
            getModelInfo: vi.fn().mockResolvedValue({ id: 'gpt-test' }),
            listModelItems: vi.fn().mockResolvedValue([{ id: 'gpt-test' }]),
        } as unknown as BaseLLMProvider
        gateway.getAllProviders().set('provider-1', provider)

        const result = await gateway.getModelInfo('gpt-test', 'provider-1')

        expect(result.cost).toMatchObject({ input: 2.5, output: 10 })
        expect(result.pricing).toMatchObject({
            prompt: 0.0000025,
            completion: 0.00001,
            inputCacheRead: 0.00000025,
        })
    })

    test('keeps native single-model pricing when models.dev has a different quote', async () => {
        const gateway = new LLMGateway()
        const provider = {
            config: { id: 'openrouter-1', type: 'openrouter' },
            getModelInfo: vi.fn().mockResolvedValue({
                id: 'deepseek/deepseek-v4.1-flash',
                pricing: { prompt: 0.00000015, completion: 0.0000006 },
            }),
        } as unknown as BaseLLMProvider
        gateway.getAllProviders().set('openrouter-1', provider)

        const result = await gateway.getModelInfo('deepseek/deepseek-v4.1-flash', 'openrouter-1')

        expect(result.pricing).toEqual({ prompt: 0.00000015, completion: 0.0000006 })
        expect(result.cost).toEqual({ input: 0.15, output: 0.6 })
    })

    test('does not cache an empty metadata response', async () => {
        metadataMocks.getModelMetadata.mockReturnValue(null)
        const gateway = new LLMGateway()
        const getModelInfo = vi.fn().mockResolvedValue({ id: 'missing-model' })
        const provider = {
            config: { id: 'provider-1', type: 'openai' },
            getModelInfo,
            listModelItems: vi.fn().mockResolvedValue([]),
        } as unknown as BaseLLMProvider
        gateway.getAllProviders().set('provider-1', provider)

        await gateway.getModelInfo('missing-model', 'provider-1')
        await gateway.getModelInfo('missing-model', 'provider-1')

        expect(getModelInfo).toHaveBeenCalledTimes(2)
    })
})
