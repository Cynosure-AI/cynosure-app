import { describe, expect, test, vi } from 'vitest'
import { EmbeddingService, type EmbeddingConfig } from './embedding.js'
import type { EmbeddingAdapter } from './embedding-adapters.js'

vi.mock('../usage-metering.js', () => ({
  estimateTextsTokens: () => 1,
  recordAuxiliaryModelUsage: () => undefined,
}))

const adapter: EmbeddingAdapter = {
  embed: vi.fn(async (texts: string[], model: string) => ({
    vectors: texts.map(() => [0.5, 0.5]), model,
  })),
}

function service(overrides: EmbeddingConfig = {}) {
  return new EmbeddingService({
    baseUrl: 'https://embeddings.example/v1', apiKey: 'first-secret', model: 'embed-v1', dimensions: 2,
    ...overrides,
  }, adapter)
}

describe('EmbeddingService', () => {
  test('requires an explicit provider and keeps the profile immutable', () => {
    expect(() => new EmbeddingService({})).toThrow(/Configure an embedding provider/)
    expect(() => service({ providerId: 'registered' })).toThrow(/either a registered embedding provider or a direct/)
    const active = service()
    expect(Object.isFrozen(active.profile)).toBe(true)
    expect(active.getConfig()).not.toHaveProperty('apiKey')
    expect(active.profile.fingerprint).toHaveLength(64)
  })

  test('fingerprints endpoint, credentials, model and dimensions', () => {
    const original = service()
    expect(service().profile.fingerprint).toBe(original.profile.fingerprint)
    for (const change of [
      { baseUrl: 'https://another.example/v1' },
      { apiKey: 'rotated-secret' },
      { model: 'embed-v2' },
      { dimensions: 3 },
    ]) {
      expect(service(change).profile.fingerprint).not.toBe(original.profile.fingerprint)
    }
    expect(JSON.stringify(original.profile)).not.toContain('first-secret')
  })

  test('tags results and rejects incompatible adapter output', async () => {
    const active = service()
    expect(await active.embed('query')).toEqual({
      vector: [0.5, 0.5], model: 'embed-v1', dimensions: 2,
      profileFingerprint: active.profile.fingerprint,
    })
    const incompatible = service({ dimensions: 3 })
    await expect(incompatible.embed('query')).rejects.toThrow(/incompatible with profile/)
    const changedModel = new EmbeddingService({ baseUrl: 'https://embeddings.example/v1', apiKey: 'secret',
      model: 'embed-v1', dimensions: 2 }, {
      embed: async () => ({ vectors: [[0.5, 0.5]], model: 'different-model' }),
    })
    await expect(changedModel.embed('query')).rejects.toThrow(/returned model/)
  })
})
