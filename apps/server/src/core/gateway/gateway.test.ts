import { beforeEach, describe, expect, test, vi } from 'vitest'

const metadataMocks = vi.hoisted(() => ({
    ensurePricingLoaded: vi.fn().mockResolvedValue(undefined),
    getModelMetadata: vi.fn(),
}))

vi.mock('../model-dev-fetcher.js', () => metadataMocks)

import { LLMGateway } from './gateway.js'
import type { BaseLLMProvider, ModelListItem } from './providers/base.provider.js'

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
})
