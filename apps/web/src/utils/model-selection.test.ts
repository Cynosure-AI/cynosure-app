import { describe, expect, test } from 'vitest'
import { resolveEffectiveProviderModel } from './model-selection'

const providers = [
  { id: 'agent-provider', defaultModel: 'agent-provider-default' },
  { id: 'other-provider', defaultModel: 'other-provider-default' },
]

describe('effective provider/model selection', () => {
  test('uses the configured agent pair', () => {
    expect(resolveEffectiveProviderModel({
      providers,
      lastUsedProviderId: 'other-provider',
      agent: { providerId: 'agent-provider', model: 'agent-model' },
    })).toEqual({ providerId: 'agent-provider', model: 'agent-model' })
  })

  test('uses an agent provider default when the agent model is empty', () => {
    expect(resolveEffectiveProviderModel({
      providers,
      lastUsedProviderId: 'other-provider',
      agent: { providerId: 'agent-provider', model: '' },
    })).toEqual({ providerId: 'agent-provider', model: 'agent-provider-default' })
  })

  test('does not carry an agent model across a provider-only override', () => {
    expect(resolveEffectiveProviderModel({
      providers,
      lastUsedProviderId: 'agent-provider',
      agent: { providerId: 'agent-provider', model: 'agent-model' },
      providerOverride: 'other-provider',
    })).toEqual({ providerId: 'other-provider', model: 'other-provider-default' })
  })

  test('distinguishes same-provider default from agent default', () => {
    expect(resolveEffectiveProviderModel({
      providers,
      lastUsedProviderId: 'other-provider',
      agent: { providerId: 'agent-provider', model: 'agent-model' },
      providerOverride: 'agent-provider',
    })).toEqual({ providerId: 'agent-provider', model: 'agent-provider-default' })
  })
})
