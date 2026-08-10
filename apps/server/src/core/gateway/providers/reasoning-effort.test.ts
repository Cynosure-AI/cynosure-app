import { describe, expect, test } from 'vitest'
import type { CompletionRequest, LLMProviderConfig } from './base.provider.js'
import { OpenAIProvider } from './openai.provider.js'
import { GrokProvider } from './grok.provider.js'

const config: LLMProviderConfig = {
    id: 'test',
    name: 'Test',
    type: 'openai',
    baseUrl: '',
    apiKey: 'test',
    defaultModel: 'test-model',
    availableModels: [],
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsVision: false,
}

class TestOpenAIProvider extends OpenAIProvider {
    normalize(effort: NonNullable<CompletionRequest['reasoningEffort']>, model: string) {
        return this.normalizeReasoningEffort(effort, model)
    }
}

class TestGrokProvider extends GrokProvider {
    normalize(effort: NonNullable<CompletionRequest['reasoningEffort']>, model: string) {
        return this.normalizeReasoningEffort(effort, model)
    }
}

describe('provider reasoning effort normalization', () => {
    test('maps the common max level to OpenAI xhigh', () => {
        const provider = new TestOpenAIProvider(config)
        expect(provider.normalize('max', 'gpt-5.4')).toBe('xhigh')
        expect(provider.normalize('minimal', 'gpt-5.4')).toBe('minimal')
    })

    test('uses xAI xhigh only for multi-agent models', () => {
        const provider = new TestGrokProvider({ ...config, type: 'grok' })
        expect(provider.normalize('minimal', 'grok-4.5')).toBe('low')
        expect(provider.normalize('xhigh', 'grok-4.5')).toBe('high')
        expect(provider.normalize('max', 'grok-4.20-multi-agent')).toBe('xhigh')
    })
})
