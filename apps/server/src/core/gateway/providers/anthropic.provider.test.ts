import { describe, expect, test, vi } from 'vitest'
import type { ChatMessage, LLMProviderConfig } from './base.provider.js'
import { AnthropicProvider } from './anthropic.provider.js'

const config: LLMProviderConfig = {
    id: 'anthropic-test',
    name: 'Anthropic',
    type: 'anthropic',
    baseUrl: '',
    apiKey: 'test',
    defaultModel: 'claude-test',
    availableModels: [],
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsVision: true
}

const ephemeral = { type: 'ephemeral' }

async function complete(messages: ChatMessage[], usage: Record<string, number> = { input_tokens: 1, output_tokens: 1 }) {
    const provider = new AnthropicProvider(config)
    const create = vi.fn().mockResolvedValue({
        id: 'msg_1',
        model: 'claude-test',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'done' }],
        usage,
    })
    ;(provider as unknown as { client: { messages: { create: typeof create } } }).client = { messages: { create } }
    const response = await provider.complete({
        model: 'claude-test',
        messages,
        tools: [{ name: 'lookup', description: 'lookup', parameters: { type: 'object' }, timeout: 1_000, execute: async () => ({ success: true, output: '' }) }],
    })
    return { params: create.mock.calls[0][0], response }
}

describe('Anthropic prompt caching', () => {
    test('marks the system prompt and the final message', async () => {
        const { params } = await complete([
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'hello' },
        ])

        expect(params.system).toEqual([{ type: 'text', text: 'sys', cache_control: ephemeral }])
        expect(params.messages).toEqual([
            { role: 'user', content: [{ type: 'text', text: 'hello', cache_control: ephemeral }] },
        ])
        expect(params.tools[0]).not.toHaveProperty('cache_control')
    })

    test('also marks the last message before turn-local context', async () => {
        const { params } = await complete([
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'earlier' },
            { role: 'assistant', content: 'answer' },
            { role: 'user', content: 'memory', metadata: { contextKind: 'retrieved-memory' } },
            { role: 'user', content: 'now' },
        ])

        expect(params.messages).toEqual([
            { role: 'user', content: 'earlier' },
            { role: 'assistant', content: [{ type: 'text', text: 'answer', cache_control: ephemeral }] },
            { role: 'user', content: 'memory' },
            { role: 'user', content: [{ type: 'text', text: 'now', cache_control: ephemeral }] },
        ])
    })

    test('marks the last tool when there is no system prompt', async () => {
        const { params } = await complete([{ role: 'user', content: 'hello' }])

        expect(params).not.toHaveProperty('system')
        expect(params.tools[0].cache_control).toEqual(ephemeral)
    })

    test('counts cached input in promptTokens and reports it separately', async () => {
        const { response } = await complete([{ role: 'user', content: 'hello' }], {
            input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 900, cache_creation_input_tokens: 90,
        })

        expect(response.usage).toEqual({
            promptTokens: 1000, completionTokens: 4, totalTokens: 1004, cacheReadTokens: 900, cacheWriteTokens: 90,
        })
    })
})
