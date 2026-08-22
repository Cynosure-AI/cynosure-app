import { afterEach, describe, expect, test, vi } from 'vitest'
import type { LLMProviderConfig } from './base.provider.js'
import { RequestyProvider } from './requesty.provider.js'

const config: LLMProviderConfig = {
    id: 'requesty-test',
    name: 'Requesty',
    type: 'requesty',
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'requesty-key',
    defaultModel: 'openai/gpt-4o',
    availableModels: [],
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsVision: true
}

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('Requesty model metadata', () => {
    test('uses Requesty endpoints and maps chat capabilities and tiered pricing', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            data: [
                {
                    api: 'chat',
                    id: 'anthropic/claude-test',
                    context_window: 200_000,
                    supports_vision: true,
                    supports_image_generation: false,
                    supports_tool_calling: true,
                    pricing: [
                        { prompt_tokens_threshold: 0, input_price: 0.000003, output_price: 0.000015, cached_price: 0.0000003 },
                        { prompt_tokens_threshold: 200_000, input_price: 0.000006, output_price: 0.0000225, cached_price: 0.0000006 }
                    ]
                },
                {
                    api: 'chat',
                    id: 'vertex/gemini-image',
                    supports_image_generation: true,
                    supports_tool_calling: false,
                    pricing: [{ prompt_tokens_threshold: 0, input_price: 0.000001, output_price: 0.000004 }]
                }
            ]
        }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)

        const provider = new RequestyProvider(config)
        const chatModels = await provider.listModelItems('llm')
        const imageModels = await provider.listModelItems('image')

        expect(provider.config.baseUrl).toBe('https://router.requesty.ai/v1')
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(String(fetchMock.mock.calls[0][0])).toBe('https://router.requesty.ai/v1/models/chat')
        expect(fetchMock.mock.calls[0][1]).toMatchObject({
            headers: { Authorization: 'Bearer requesty-key' }
        })
        expect(chatModels[0]).toMatchObject({
            id: 'anthropic/claude-test',
            contextLength: 200_000,
            inputModalities: ['text', 'image'],
            outputModalities: ['text'],
            supportsToolCalls: true,
            pricing: {
                prompt: 0.000003,
                completion: 0.000015,
                inputCacheRead: 0.0000003,
                tiers: [{
                    minPromptTokens: 200_000,
                    prompt: 0.000006,
                    completion: 0.0000225,
                    inputCacheRead: 0.0000006
                }]
            }
        })
        expect(imageModels).toHaveLength(1)
        expect(imageModels[0]).toMatchObject({
            id: 'vertex/gemini-image',
            outputModalities: ['text', 'image']
        })
    })

    test('maps embedding and transcription model pricing units', async () => {
        vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string | URL | Request) => {
            const url = String(input)
            if (url.endsWith('/models/embedding')) {
                return new Response(JSON.stringify({ data: [{
                    api: 'embedding',
                    id: 'openai/text-embedding-3-small',
                    pricing: { input_text: 0.00000002 }
                }] }), { status: 200 })
            }
            return new Response(JSON.stringify({ data: [{
                api: 'transcription',
                id: 'openai/whisper-1',
                pricing: { input_second: 0.0001 }
            }] }), { status: 200 })
        }))

        const provider = new RequestyProvider(config)
        const embeddings = await provider.listModelItems('embedding')
        const transcriptions = await provider.listModelItems('transcription')

        expect(embeddings[0]).toMatchObject({
            outputModalities: ['embeddings'],
            pricing: { prompt: 0.00000002, skus: { input_text: 0.00000002 } }
        })
        expect(transcriptions[0]).toMatchObject({
            inputModalities: ['audio'],
            outputModalities: ['transcription'],
            pricing: { skus: { input_second: 0.0001 } }
        })
    })
})

describe('Requesty requests', () => {
    test('sends Requesty reasoning_effort and reads reasoning_content', async () => {
        const provider = new RequestyProvider(config)
        const create = vi.fn().mockResolvedValue({
            id: 'completion-1',
            model: 'anthropic/claude-test',
            choices: [{
                finish_reason: 'stop',
                message: { content: 'answer', reasoning_content: 'thinking' }
            }],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
        })
        ;(provider as unknown as {
            client: { chat: { completions: { create: typeof create } } }
        }).client = { chat: { completions: { create } } }

        const response = await provider.complete({
            model: 'anthropic/claude-test',
            messages: [{ role: 'user', content: 'hello' }],
            thinkingEnabled: true,
            reasoningEffort: 'minimal'
        })

        expect(create.mock.calls[0][0]).toMatchObject({ reasoning_effort: 'min' })
        expect(create.mock.calls[0][0]).not.toHaveProperty('reasoning')
        expect(response).toMatchObject({ content: 'answer', thinking: 'thinking' })
    })

    test('uploads transcription audio as multipart form data', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: 'hello' }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)
        const provider = new RequestyProvider(config)

        await expect(provider.transcribeAudio({
            model: 'openai/gpt-4o-transcribe',
            inputAudio: { data: 'SU4=', format: 'mp3' },
            language: 'en'
        })).resolves.toEqual({ text: 'hello' })

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
        expect(url).toBe('https://router.requesty.ai/v1/audio/transcriptions')
        expect(init.headers).toEqual({ Authorization: 'Bearer requesty-key' })
        expect(init.body).toBeInstanceOf(FormData)
        const body = init.body as FormData
        expect(body.get('model')).toBe('openai/gpt-4o-transcribe')
        expect(body.get('language')).toBe('en')
        expect(body.get('file')).toBeInstanceOf(Blob)
    })
})
