import { describe, expect, test } from 'vitest'
import type { LLMGateway } from '../../gateway/gateway.js'
import { resolveTaskContextRouter } from './execution-resolvers.js'

const gateway = {
    getProvider: (id: string) => ({ config: { id, defaultModel: 'provider-default' } }),
} as unknown as LLMGateway

const base = {
    gateway,
    fallbackProviderId: 'selected-provider',
    fallbackModel: 'selected-model',
    preset: { id: 'agent', tools: [], subAgents: [], providerId: 'agent-provider', model: 'agent-model' },
    requestRouterProviderId: 'old-global-provider',
    requestRouterModel: 'old-global-model',
}

describe('context router model selection', () => {
    test.each([
        {},
        { autoRouterProviderId: '', autoRouterModel: '' },
        { autoRouterProviderId: '__agent_provider__', autoRouterModel: '__agent_model__' },
    ])('uses the selected model for default configuration %j', config => {
        expect(resolveTaskContextRouter({ ...base, preset: { ...base.preset, ...config } })).toEqual({ providerId: 'selected-provider', model: 'selected-model' })
    })
    test('preserves an explicit agent router override', () => {
        expect(resolveTaskContextRouter({ ...base, preset: { ...base.preset, autoRouterProviderId: 'custom', autoRouterModel: 'custom-model' } })).toEqual({ providerId: 'custom', model: 'custom-model' })
    })
})
