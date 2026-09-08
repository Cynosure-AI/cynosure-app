import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import MemorySettings from './MemorySettings.vue'

const mocks = vi.hoisted(() => ({
  getEmbeddingConfig: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  api: {
    provider: {
      loadSaved: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([{
        id: 'provider-1',
        name: 'Provider',
        type: 'openai',
        baseUrl: 'https://example.com',
        defaultModel: 'chat-model',
        availableModels: [],
        supportsStreaming: true,
        supportsToolCalls: true,
        supportsVision: false,
      }]),
      getLastUsed: vi.fn().mockResolvedValue('provider-1'),
    },
    memory: {
      onReembedProgress: vi.fn(() => () => undefined),
      getEmbeddingConfig: mocks.getEmbeddingConfig,
      getEntityExtractionConfig: vi.fn().mockResolvedValue({ providerId: '', model: '' }),
      getChunkingConfig: vi.fn().mockResolvedValue({ chunkSize: 512, chunkOverlap: 64 }),
      getRetrievalConfig: vi.fn().mockResolvedValue({ resultCount: 10 }),
      getRerankerConfig: vi.fn().mockResolvedValue({
        enabled: false,
        providerId: '',
        model: '',
        candidateCount: 50,
      }),
    },
  },
}))

vi.mock('../../utils/electron-prefs', () => ({
  syncPrefsToElectron: vi.fn(),
}))

describe('MemorySettings dirty state', () => {
  beforeEach(() => {
    mocks.getEmbeddingConfig.mockReset().mockResolvedValue({
      providerId: 'provider-1',
      model: 'text-embedding-3-small',
      dimensions: 1536,
    })
  })

  test('does not report loaded configuration as unsaved', async () => {
    const wrapper = shallowMount(MemorySettings, {
      global: { plugins: [createPinia()] },
    })

    await flushPromises()

    expect(wrapper.emitted('dirty-change')?.at(-1)).toEqual([false])
    expect(wrapper.emitted('dirty-change')?.some(([dirty]) => dirty === true)).toBe(false)
  })
})
