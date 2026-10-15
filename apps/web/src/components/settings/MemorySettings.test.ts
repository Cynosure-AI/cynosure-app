import { flushPromises, mount, shallowMount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import MemorySettings from './MemorySettings.vue'
import ProviderModelSelect from '../shared/ProviderModelSelect.vue'

const mocks = vi.hoisted(() => ({
  getEmbeddingConfig: vi.fn(),
  getDreamConfig: vi.fn(),
  configureDream: vi.fn(),
  probeEmbedding: vi.fn(),
  configureEmbeddings: vi.fn(),
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
      }, {
        id: 'provider-2',
        name: 'Unsloth Studio',
        type: 'unsloth',
        baseUrl: 'http://localhost:8888/v1',
        defaultModel: '',
        availableModels: [],
        supportsStreaming: true,
        supportsToolCalls: true,
        supportsVision: false,
      }]),
      getLastUsed: vi.fn().mockResolvedValue('provider-1'),
    },
    memory: {
      onReembedProgress: vi.fn(() => () => undefined),
      getLimits: vi.fn().mockResolvedValue({
        analysisChunkLimit: 20,
        chunking: { minChunkSize: 64, maxChunkSize: 4096, defaultChunkSize: 512, defaultChunkOverlap: 64 },
        attachments: { minInlineTextLimit: 2_000, maxInlineTextLimit: 500_000, defaultInlineTextLimit: 24_000 },
        chunkReadLimit: 20,
        graph: { maxNodes: 5000, defaultNodes: 80, maxSuggestions: 20, defaultSuggestions: 8, maxSeedNodes: 50, maxFolders: 100 },
      }),
      getDreamConfig: mocks.getDreamConfig,
      configureDream: mocks.configureDream,
      getEmbeddingConfig: mocks.getEmbeddingConfig,
      probeEmbedding: mocks.probeEmbedding,
      configureEmbeddings: mocks.configureEmbeddings,
      getDeepResearchConfig: vi.fn().mockResolvedValue({ providerId: '', model: '' }),
      getRerankerConfig: vi.fn().mockResolvedValue({
        enabled: false,
        providerId: '',
        model: '',
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
    mocks.getDreamConfig.mockReset().mockResolvedValue({ providerId: '', model: '' })
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
  test('has no separate on/off switch and saves the selected model', async () => {
    const wrapper = createDreamSettings()
    await flushPromises()
    expect(wrapper.text()).toContain('Building Knowledge')
    expect(wrapper.text()).toContain('Dream Mode')
    expect(wrapper.text()).not.toContain('Experimental')
    expect(wrapper.text()).toContain('provider costs')
    expect(wrapper.find('[role="switch"]').exists()).toBe(false)
    wrapper.getComponent(ProviderModelSelect).vm.$emit('change', { providerId: 'provider', model: 'model' })
    await flushPromises()
    expect(wrapper.text()).toContain('Unsaved changes')
    await wrapper.findAll('button').find(button => button.text() === 'Save Dream Config')!.trigger('click')
    await flushPromises()
    expect(mocks.configureDream).toHaveBeenCalledWith({ providerId: 'provider', model: 'model' })
    expect(wrapper.text()).not.toContain('Unsaved changes')
    wrapper.unmount()
  })
  test('loads persisted configuration and displays a failed save', async () => {
    mocks.getDreamConfig.mockResolvedValue({ providerId: 'provider', model: 'model' })
    mocks.configureDream.mockRejectedValue(new Error('Provider unavailable'))
    const wrapper = createDreamSettings()
    await flushPromises()
    expect(wrapper.getComponent(ProviderModelSelect).props('modelValue')).toBe('model')
    wrapper.getComponent(ProviderModelSelect).vm.$emit('change', { providerId: 'provider', model: 'other-model' })
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === 'Save Dream Config')!.trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('Provider unavailable')
    wrapper.unmount()
  })
  test('allows a provider default with no explicit model', async () => {
    const wrapper = createDreamSettings()
    await flushPromises()
    wrapper.getComponent(ProviderModelSelect).vm.$emit('change', { providerId: 'provider-1', model: '' })
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === 'Save Dream Config')!.trigger('click')
    await flushPromises()
    expect(mocks.configureDream).toHaveBeenCalledWith({ providerId: 'provider-1', model: '' })
    wrapper.unmount()
  })
  test('turns Dream off by clearing the model', async () => {
    mocks.getDreamConfig.mockResolvedValue({ providerId: 'provider', model: 'model' })
    const wrapper = createDreamSettings()
    await flushPromises()
    expect(wrapper.getComponent(ProviderModelSelect).props('includeDefault')).toBe(true)
    wrapper.getComponent(ProviderModelSelect).vm.$emit('change', { providerId: '', model: '' })
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === 'Save Dream Config')!.trigger('click')
    await flushPromises()
    expect(mocks.configureDream).toHaveBeenCalledWith({ providerId: '', model: '' })
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

describe('Embedding model settings', () => {
  beforeEach(() => {
    mocks.getEmbeddingConfig.mockReset().mockResolvedValue({ providerId: 'provider-1', model: 'embed-small', dimensions: 768 })
    mocks.getDreamConfig.mockReset().mockResolvedValue({ providerId: '', model: '' })
    mocks.probeEmbedding.mockReset()
    mocks.configureEmbeddings.mockReset()
  })

  test('an unreachable embedding model is reported and not saved', async () => {
    mocks.probeEmbedding.mockRejectedValue(new Error('404 model not found'))
    const wrapper = mount(MemorySettings, {
      props: { visibleSections: ['embedding-model'] },
      global: { plugins: [createPinia()], stubs: { ProviderModelSelect: true, Icon: true } },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('768 dimensions')

    wrapper.getComponent(ProviderModelSelect).vm.$emit('change', { providerId: 'provider-1', model: 'embed-missing' })
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === 'Save changes')!.trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toBe('The embedding model did not respond: 404 model not found')
    expect(mocks.configureEmbeddings).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  test('one selector lists embedding models from every provider', async () => {
    const wrapper = mount(MemorySettings, {
      props: { visibleSections: ['embedding-model'] },
      global: { plugins: [createPinia()], stubs: { ProviderModelSelect: true, Icon: true } },
    })
    await flushPromises()
    const modelSelect = () => wrapper.getComponent(ProviderModelSelect)

    expect(modelSelect().props('providers').map((provider: { id: string }) => provider.id)).toEqual(['provider-1', 'provider-2'])
    expect(modelSelect().props('hideEmptyProviders')).toBe(true)

    modelSelect().vm.$emit('change', { providerId: 'provider-2', model: 'embed-local' })
    await flushPromises()
    expect(modelSelect().props('providerId')).toBe('provider-2')
    expect(modelSelect().props('modelValue')).toBe('embed-local')
    expect(wrapper.text()).not.toContain('dimensions')

    modelSelect().vm.$emit('change', { providerId: 'provider-1', model: 'embed-small' })
    await flushPromises()
    expect(wrapper.text()).toContain('768 dimensions')
    wrapper.unmount()
  })
})
