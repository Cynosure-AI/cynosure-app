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

describe('models.dev saved index', () => {
    let directory = ''

    afterEach(async () => {
        vi.unstubAllGlobals()
        vi.useRealTimers()
        const { closeDb } = await import('../db/database.js')
        closeDb()
        vi.resetModules()
        delete process.env.CYNOSURE_DATA_DIR
        if (directory) await (await import('node:fs/promises')).rm(directory, { recursive: true, force: true })
    })

    test('a restart prices models from the saved index and refreshes it in the background once stale', async () => {
        const { mkdtemp } = await import('node:fs/promises')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
        directory = await mkdtemp(join(tmpdir(), 'cynosure-models-dev-'))
        process.env.CYNOSURE_DATA_DIR = directory
        const catalogue = (input: number) => new Response(JSON.stringify({ openai: { id: 'openai', models: { 'gpt-test': { cost: { input, output: 10 } } } } }))
        const fetch = vi.fn().mockResolvedValue(catalogue(2.5))
        vi.stubGlobal('fetch', fetch)
        await (await import('./model-dev-fetcher.js')).ensurePricingLoaded()

        // A new process: the saved index answers without a network call.
        vi.resetModules()
        fetch.mockClear()
        const restarted = await import('./model-dev-fetcher.js')
        await restarted.ensurePricingLoaded()
        expect(restarted.getModelCost('openai', 'gpt-test')).toEqual({ input: 2.5, output: 10 })
        expect(fetch).not.toHaveBeenCalled()

        // A day later the stale index still answers at once while a refresh runs.
        vi.resetModules()
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000)
        let release!: () => void
        fetch.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(catalogue(3)) }))
        const nextDay = await import('./model-dev-fetcher.js')
        await nextDay.ensurePricingLoaded()
        expect(nextDay.getModelCost('openai', 'gpt-test')).toEqual({ input: 2.5, output: 10 })
        expect(fetch).toHaveBeenCalledTimes(1)
        release()
        await vi.waitFor(() => expect(nextDay.getModelCost('openai', 'gpt-test')).toEqual({ input: 3, output: 10 }))
    })
})
