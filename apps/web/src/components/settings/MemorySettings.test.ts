import { flushPromises, mount, shallowMount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import MemorySettings from './MemorySettings.vue'
import ProviderModelSelect from '../shared/ProviderModelSelect.vue'

const mocks = vi.hoisted(() => ({
  getEmbeddingConfig: vi.fn(),
  getDreamConfig: vi.fn(),
  configureDream: vi.fn(),
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
      getDreamConfig: mocks.getDreamConfig,
      configureDream: mocks.configureDream,
      getEmbeddingConfig: mocks.getEmbeddingConfig,
      getDeepResearchConfig: vi.fn().mockResolvedValue({ providerId: '', model: '' }),
      getChunkingConfig: vi.fn().mockResolvedValue({ chunkSize: 512, chunkOverlap: 64 }),
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
    mocks.getDreamConfig.mockReset().mockResolvedValue({ enabled: false, providerId: '', model: '' })
    mocks.configureDream.mockReset().mockImplementation(async (config) => config)
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

const createDreamSettings = () => mount(MemorySettings, {
  props: { visibleSections: ['dream-mode'] },
  global: {
    plugins: [createPinia()],
    stubs: { ProviderModelSelect: true, Icon: true },
  },
})

describe('Dream settings', () => {
  test('shows experimental opt-in and requires a model before enabling', async () => {
    const wrapper = createDreamSettings()
    await flushPromises()
    expect(wrapper.text()).toContain('Building Knowledge')
    expect(wrapper.text()).toContain('Dream Mode')
    expect(wrapper.text()).toContain('Experimental')
    expect(wrapper.text()).toContain('provider costs')
    const toggle = wrapper.get('[role="switch"]')
    expect(toggle.attributes('aria-checked')).toBe('false')
    expect(toggle.attributes('disabled')).toBeDefined()
    wrapper.getComponent(ProviderModelSelect).vm.$emit('change', { providerId: 'provider', model: 'model' })
    await flushPromises()
    await toggle.trigger('click')
    await wrapper.findAll('button').find(button => button.text() === 'Save Dream Config')!.trigger('click')
    await flushPromises()
    expect(mocks.configureDream).toHaveBeenCalledWith({ enabled: true, providerId: 'provider', model: 'model' })
    wrapper.unmount()
  })
  test('loads persisted configuration and displays a failed save', async () => {
    mocks.getDreamConfig.mockResolvedValue({ enabled: true, providerId: 'provider', model: 'model' })
    mocks.configureDream.mockRejectedValue(new Error('Provider unavailable'))
    const wrapper = createDreamSettings()
    await flushPromises()
    expect(wrapper.get('[role="switch"]').attributes('aria-checked')).toBe('true')
    await wrapper.findAll('button').find(button => button.text() === 'Save Dream Config')!.trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('Provider unavailable')
    wrapper.unmount()
  })
  test('does not overwrite settings when loading failed', async () => {
    mocks.getDreamConfig.mockRejectedValue(new Error('Settings unavailable'))
    const wrapper = createDreamSettings()
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('Settings unavailable')
    expect(wrapper.findAll('button').find(button => button.text() === 'Save Dream Config')!.attributes('disabled')).toBeDefined()
    expect(mocks.configureDream).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
