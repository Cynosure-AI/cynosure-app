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
  })

  test('accepts a provider canonicalizing the model name while retaining the requested profile', async () => {
    const active = new EmbeddingService({ baseUrl: 'https://embeddings.example/v1', apiKey: 'secret',
      model: 'qwen/qwen3-embedding-8b', dimensions: 2 }, {
      embed: async () => ({ vectors: [[0.5, 0.5]], model: 'Qwen/Qwen3-Embedding-8B' }),
    })
    expect(await active.embed('query')).toMatchObject({
      model: 'Qwen/Qwen3-Embedding-8B', profileFingerprint: active.profile.fingerprint,
    })
  })

  test('rejects a genuinely different provider model', async () => {
    const active = new EmbeddingService({ baseUrl: 'https://embeddings.example/v1',
      model: 'qwen/qwen3-embedding-8b', dimensions: 2 }, {
      embed: async () => ({ vectors: [[0.5, 0.5]], model: 'other/embedding-model' }),
    })
    await expect(active.embed('query')).rejects.toThrow(/Embedding provider returned model/)
  })
})

describe('query formatting for instruction-tuned embedding models', () => {
  test('adds the Qwen3 retrieval instruction to queries only for instruction-tuned models', async () => {
    const { formatEmbeddingQuery } = await import('./embedding.js')
    expect(formatEmbeddingQuery('qwen/qwen3-embedding-8b', 'wer ist belinda?')).toMatch(/^Instruct: .+\nQuery: wer ist belinda\?$/)
    expect(formatEmbeddingQuery('BAAI/bge-large-en-v1.5', 'who is belinda?')).toBe('Represent this sentence for searching relevant passages: who is belinda?')
    expect(formatEmbeddingQuery('text-embedding-3-small', 'who is belinda?')).toBe('who is belinda?')
    expect(formatEmbeddingQuery('BAAI/bge-m3', 'who is belinda?')).toBe('who is belinda?')
  })
})
