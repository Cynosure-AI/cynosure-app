import { afterEach, describe, expect, test, vi } from 'vitest'
import { IncompleteModelResponseError, type LLMProviderConfig, type StreamChunk } from './base.provider.js'
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
    vi.restoreAllMocks()
})

function mockChatStream(provider: OpenRouterProvider, chunks: unknown[]): void {
    const create = vi.fn().mockResolvedValue((async function* () {
        for (const chunk of chunks) yield chunk
    })())
    ;(provider as unknown as {
        client: { chat: { completions: { create: typeof create } } }
    }).client = { chat: { completions: { create } } }
}

async function collectStream(provider: OpenRouterProvider): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = []
    for await (const chunk of provider.streamComplete({
        model: 'test/model',
        messages: [{ role: 'user', content: 'hello' }],
    })) {
        chunks.push(chunk)
    }
    return chunks
}

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

describe('OpenRouter model metadata', () => {
    test('keeps tool support, pricing tiers and explicit transcription units', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
            data: [
                {
                    id: 'openai/whisper-large-v3',
                    architecture: { input_modalities: ['audio'], output_modalities: ['transcription'] },
                    supported_parameters: [],
                    pricing: { prompt: '0.0000075', completion: '0' }
                },
                {
                    id: 'test/tiered',
                    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
                    supported_parameters: ['tools'],
                    pricing: {
                        prompt: '0.000001',
                        completion: '0.000002',
                        overrides: [{ min_prompt_tokens: 200000, prompt: '0.000002', completion: '0.000004' }]
                    }
                }
            ]
        }), { status: 200 })))

        const models = await new OpenRouterProvider(config).listModelItems('llm')
        expect(models.find((model) => model.id === 'test/tiered')).toMatchObject({
            supportsToolCalls: true,
            pricing: {
                tiers: [{ minPromptTokens: 200000, prompt: 0.000002, completion: 0.000004 }]
            }
        })
        expect(models.find((model) => model.id === 'openai/whisper-large-v3')?.pricing).toMatchObject({
            prompt: 0,
            completion: 0,
            skus: { per_audio_minute: 0.0015 }
        })
    })
})

describe('OpenRouter completion termination', () => {
    test('accepts a natural stop as a completed stream', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 })))
        const provider = new OpenRouterProvider(config)
        mockChatStream(provider, [
            { choices: [{ delta: { content: 'done' }, finish_reason: null }], usage: null },
            { choices: [{ delta: {}, finish_reason: 'stop' }], usage: null },
            { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
        ])

        const chunks = await collectStream(provider)

        expect(chunks.at(-1)).toEqual({
            done: true,
            toolCalls: undefined,
            usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
        })
    })

    test('rejects a token-limited stream instead of marking it done', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 })))
        const provider = new OpenRouterProvider(config)
        mockChatStream(provider, [
            { choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }], usage: null },
        ])

        await expect(collectStream(provider)).rejects.toMatchObject({
            name: 'IncompleteModelResponseError',
            reason: 'length',
        } satisfies Partial<IncompleteModelResponseError>)
    })

    test('rejects a stream that closes without a finish reason', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 })))
        const provider = new OpenRouterProvider(config)
        mockChatStream(provider, [
            { choices: [{ delta: { content: 'partial' }, finish_reason: null }], usage: null },
        ])

        await expect(collectStream(provider)).rejects.toThrow('before a finish reason')
    })
})
