import type { LLMProviderConfig } from '../api/types'

type ProviderSummary = Pick<LLMProviderConfig, 'id' | 'defaultModel'>

export interface ModelSelectionAgent {
  providerId?: string | null
  model?: string | null
}

export function resolveEffectiveProviderModel(params: {
  providers: ProviderSummary[]
  lastUsedProviderId?: string | null
  agent?: ModelSelectionAgent | null
  providerOverride?: string | null
  modelOverride?: string | null
}): { providerId: string; model: string } | null {
  const { providers, lastUsedProviderId, agent, providerOverride, modelOverride } = params
  const lastUsed = providers.find((provider) => provider.id === lastUsedProviderId)

  let providerId = agent?.providerId || lastUsed?.id
  let model = agent?.model || undefined

  if (!providerId && lastUsed) {
    providerId = lastUsed.id
    model ||= lastUsed.defaultModel
  }

  if (providerOverride) providerId = providerOverride
  const provider = providers.find((item) => item.id === providerId) || lastUsed
  if (!provider) return null

  if (modelOverride) {
    model = modelOverride
  } else if (providerOverride || !model) {
    model = provider.defaultModel
  }

  return model ? { providerId: provider.id, model } : null
}
