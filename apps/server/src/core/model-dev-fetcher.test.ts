import { afterEach, describe, expect, test, vi } from 'vitest'

describe('models.dev metadata normalization', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
        vi.resetModules()
    })

    test('uses one metadata record for costs, capabilities and OpenRouter-style ids', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
            openai: {
                id: 'openai',
                models: {
                    'gpt-test': {
                        cost: { input: 2.5, output: 10, cache_read: 0.25 },
                        limit: { context: 128_000 },
                        modalities: { input: ['text', 'image'], output: ['text'] },
                        tool_call: true,
                    },
                    'gpt-free': {
                        cost: { input: 0, output: 0 },
                    },
                },
            },
        }))))

        const metadata = await import('./model-dev-fetcher.js')
        await metadata.ensurePricingLoaded()

        expect(metadata.getModelMetadata('openai', 'gpt-test')).toEqual({
            cost: { input: 2.5, output: 10, cacheRead: 0.25 },
            contextLength: 128_000,
            inputModalities: ['text', 'image'],
            outputModalities: ['text'],
            supportsToolCalls: true,
        })
        expect(metadata.getModelCost('openrouter', 'openai/gpt-test')).toEqual({ input: 2.5, output: 10, cacheRead: 0.25 })
        expect(metadata.getModelCost('openai', 'gpt-free')).toEqual({ input: 0, output: 0 })
        expect(metadata.getModelCost('ollama', 'gpt-test')).toBeNull()
    })

    test('does not borrow metadata from an ambiguous model id on another host', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
            'host-a': {
                id: 'host-a',
                models: { shared: { cost: { input: 1, output: 2 } } },
            },
            'host-b': {
                id: 'host-b',
                models: { shared: { cost: { input: 10, output: 20 } } },
            },
        }))))

        const metadata = await import('./model-dev-fetcher.js')
        await metadata.ensurePricingLoaded()

        expect(metadata.getModelCost('host-a', 'shared')).toEqual({ input: 1, output: 2 })
        expect(metadata.getModelCost('host-b', 'shared')).toEqual({ input: 10, output: 20 })
        expect(metadata.getModelCost('unrelated-host', 'shared')).toBeNull()
    })
})
