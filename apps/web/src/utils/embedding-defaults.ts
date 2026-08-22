import type { LLMProviderConfig } from '../api/types'

type ProviderType = LLMProviderConfig['type']

const DEFAULT_EMBEDDING_MODELS: Partial<Record<ProviderType, string>> = {
  openrouter: 'qwen/qwen3-embedding-8b',
  requesty: 'openai/text-embedding-3-small',
  openai: 'text-embedding-3-small',
  google: 'google-embedding-001',
}

export function defaultEmbeddingModelForProvider(type?: ProviderType): string {
  return type ? DEFAULT_EMBEDDING_MODELS[type] || '' : ''
}

export function defaultEmbeddingModelForProviderId(
  providerId: string,
  providers: LLMProviderConfig[]
): string {
  return defaultEmbeddingModelForProvider(
    providers.find((provider) => provider.id === providerId)?.type
  )
}

export function withDefaultEmbeddingModel(models: string[], defaultModel: string): string[] {
  if (!defaultModel) return models

  const remainingModels = models.filter((model) => model !== defaultModel)
  return [defaultModel, ...remainingModels]
}
