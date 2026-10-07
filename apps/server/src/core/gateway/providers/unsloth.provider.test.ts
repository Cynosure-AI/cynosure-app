import { afterEach, describe, expect, test, vi } from 'vitest'
import type { LLMProviderConfig } from './base.provider.js'
import { UnslothProvider } from './unsloth.provider.js'

const config: LLMProviderConfig = {
    id: 'unsloth-test',
    name: 'Unsloth Studio',
    type: 'unsloth',
    baseUrl: 'http://studio.local:9000/v1/',
    apiKey: 'sk-unsloth-test',
    defaultModel: 'gemma-4-26B-A4B-it-GGUF',
    availableModels: [],
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsVision: true
}

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('Unsloth Studio provider', () => {
    test('lists loaded chat models from the configured server with the API key', async () => {
        const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
            data: [{ id: 'qwen3-8b-GGUF' }, { id: 'gemma-4-26B-A4B-it-GGUF', context_length: 131072 }]
        }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)

        const provider = new UnslothProvider(config)

        expect(await provider.listModelItems('llm')).toEqual([
            { id: 'gemma-4-26B-A4B-it-GGUF' },
            { id: 'qwen3-8b-GGUF' }
        ])
        expect(String(fetchMock.mock.calls[0][0])).toBe('http://studio.local:9000/v1/models')
        expect(fetchMock.mock.calls[0][1]).toMatchObject({
            headers: { Authorization: 'Bearer sk-unsloth-test' }
        })
        expect(await provider.getModelInfo('gemma-4-26B-A4B-it-GGUF')).toEqual({
            id: 'gemma-4-26B-A4B-it-GGUF',
            contextLength: 131072
        })
    })

    test('serves no embedding, image, video, or transcription models', async () => {
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)
        const provider = new UnslothProvider(config)

        for (const type of ['embedding', 'image', 'video', 'transcription'] as const) {
            expect(await provider.listModelItems(type)).toEqual([])
        }
        expect(fetchMock).not.toHaveBeenCalled()
    })

    test('falls back to the default local address', () => {
        expect(new UnslothProvider({ ...config, baseUrl: '' }).config.baseUrl).toBe('http://localhost:8888/v1')
    })
})
