import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import ProviderModelSelect from './ProviderModelSelect.vue'
import { useProviderStore } from '../../stores/provider.store'
import { api } from '../../api/client'
import { SK_PROVIDER_MODEL_FAVORITES } from '../../utils/storage-keys'

describe('ProviderModelSelect favorites', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    vi.spyOn(api.modelFavorites, 'get').mockResolvedValue({ favorites: [], initialized: false })
    vi.spyOn(api.modelFavorites, 'save').mockImplementation(async favorites => ({ favorites }))
  })

  test('restores favorites from app storage instead of a stale browser copy', async () => {
    localStorage.setItem(SK_PROVIDER_MODEL_FAVORITES, JSON.stringify([{
      providerId: 'old-provider', model: 'old-model', modelType: 'llm', label: 'old-model',
    }]))
    vi.mocked(api.modelFavorites.get).mockResolvedValue({
      initialized: true,
      favorites: [{ providerId: 'openai-1', model: 'gpt-test', modelType: 'llm', label: 'gpt-test' }],
    })
    const store = useProviderStore()
    store.listModelItems = vi.fn().mockResolvedValue([])
    const wrapper = mount(ProviderModelSelect, {
      props: {
        providerId: 'openai-1', modelValue: '',
        providers: [{ id: 'openai-1', name: 'OpenAI', type: 'openai', defaultModel: 'gpt-test' }],
      },
      global: { stubs: { Icon: true } },
    })
    await flushPromises()
    expect(JSON.parse(localStorage.getItem(SK_PROVIDER_MODEL_FAVORITES) || '[]'))
      .toMatchObject([{ providerId: 'openai-1', model: 'gpt-test' }])
    await wrapper.get('[role="combobox"]').trigger('click')
    expect(wrapper.text()).toContain('Favorites')
  })

  test('imports existing browser favorites when app storage is empty', async () => {
    localStorage.setItem(SK_PROVIDER_MODEL_FAVORITES, JSON.stringify([{
      providerId: 'openai-1', model: 'gpt-test', modelType: 'llm', label: 'gpt-test',
    }]))
    const store = useProviderStore()
    store.listModelItems = vi.fn().mockResolvedValue([])
    mount(ProviderModelSelect, {
      props: {
        providerId: 'openai-1', modelValue: '',
        providers: [{ id: 'openai-1', name: 'OpenAI', type: 'openai', defaultModel: 'gpt-test' }],
      },
      global: { stubs: { Icon: true } },
    })
    await flushPromises()
    expect(api.modelFavorites.save).toHaveBeenCalledWith([
      { providerId: 'openai-1', model: 'gpt-test', modelType: 'llm', label: 'gpt-test' },
    ])
  })

  test('reattaches pricing metadata to a favorited model row', async () => {
    localStorage.setItem(SK_PROVIDER_MODEL_FAVORITES, JSON.stringify([{
      providerId: 'openai-1',
      model: 'gpt-test',
      modelType: 'llm',
      label: 'gpt-test',
    }]))

    const store = useProviderStore()
    store.listModelItems = vi.fn().mockResolvedValue([{
      id: 'gpt-test',
      pricing: { prompt: 0.0000025, completion: 0.00001 },
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
    }])

    const wrapper = mount(ProviderModelSelect, {
      props: {
        providerId: 'openai-1',
        modelValue: 'gpt-test',
        providers: [{ id: 'openai-1', name: 'OpenAI', type: 'openai', defaultModel: 'gpt-test' }],
      },
      global: {
        stubs: { Icon: true },
      },
    })
    await flushPromises()

    expect(wrapper.get('[role="combobox"]').text()).not.toContain('$2.50 / $10.00/M')
    await wrapper.get('[role="combobox"]').trigger('click')

    const matchingRows = wrapper.findAll('[role="option"]')
      .filter((row) => row.text().includes('gpt-test'))
    expect(matchingRows.length).toBeGreaterThanOrEqual(2)
    expect(matchingRows[0].attributes('title')).toContain('Input / Output: $2.50 / $10.00 per 1M tokens')
    expect(matchingRows[0].text()).toContain('$2.50 / $10.00/M')
  })

  test('persists the actual media model type from a combined selector', async () => {
    const store = useProviderStore()
    store.listModelItems = vi.fn().mockImplementation(async (_providerId, type) =>
      type === 'transcription'
        ? [{ id: 'speech/model', outputModalities: ['transcription'], pricing: { prompt: 0.001 } }]
        : []
    )

    const wrapper = mount(ProviderModelSelect, {
      props: {
        providerId: 'openrouter-1',
        modelValue: 'speech/model',
        providers: [{ id: 'openrouter-1', name: 'OpenRouter', type: 'openrouter', defaultModel: 'text/model' }],
        modelTypes: ['llm', 'image', 'video', 'transcription'],
      },
      global: { stubs: { Icon: true } },
    })
    await flushPromises()
    expect(wrapper.get('[role="combobox"]').text()).toContain('model')
    expect(wrapper.get('[role="combobox"]').text()).not.toContain('speech/model')
    await wrapper.get('[role="combobox"]').trigger('click')
    const row = wrapper.findAll('[role="option"]')
      .find((option) => (option.attributes('data-value') || '').includes('speech/model'))!
    expect(row.text()).toContain('speech/model')
    expect(row.text()).toContain('$')
    expect(row.text()).not.toContain('Transcription')
    await row.get('[aria-label="Add to favorites"]').trigger('click')

    expect(JSON.parse(localStorage.getItem(SK_PROVIDER_MODEL_FAVORITES) || '[]')).toMatchObject([
      { providerId: 'openrouter-1', model: 'speech/model', modelType: 'transcription' },
    ])
  })

  test('uses an amber pricing tag for video output models', async () => {
    const store = useProviderStore()
    store.listModelItems = vi.fn().mockImplementation(async (_providerId, type) =>
      type === 'video'
        ? [{ id: 'video/model', inputModalities: ['text', 'image'], outputModalities: ['video'], pricing: { prompt: 0.001 } }]
        : []
    )

    const wrapper = mount(ProviderModelSelect, {
      props: {
        providerId: 'openrouter-video',
        modelValue: 'video/model',
        providers: [{ id: 'openrouter-video', name: 'OpenRouter', type: 'openrouter', defaultModel: '' }],
        modelTypes: ['llm', 'image', 'video', 'transcription'],
      },
      global: { stubs: { Icon: true } },
    })
    await flushPromises()
    await wrapper.get('[role="combobox"]').trigger('click')

    const row = wrapper.findAll('[role="option"]')
      .find((option) => (option.attributes('data-value') || '').includes('video/model'))!
    expect(row.find('.text-amber-400').exists()).toBe(true)
  })

  test('shortens agent and provider defaults only in the collapsed trigger', async () => {
    const store = useProviderStore()
    store.listModelItems = vi.fn().mockResolvedValue([])

    const wrapper = mount(ProviderModelSelect, {
      props: {
        providerId: '',
        modelValue: '',
        providers: [{
          id: 'openrouter-1',
          name: 'OpenRouter',
          type: 'openrouter',
          defaultModel: 'deepseek/deepseek-v4-flash-0731',
        }],
        includeDefault: true,
        defaultLabel: 'deepseek/deepseek-v4-flash-0731',
      },
      global: { stubs: { Icon: true } },
    })
    await flushPromises()

    expect(wrapper.get('[role="combobox"]').text()).toContain('deepseek-v4-flash-0731')
    expect(wrapper.get('[role="combobox"]').text()).not.toContain('deepseek/deepseek-v4-flash-0731')

    await wrapper.get('[role="combobox"]').trigger('click')
    expect(wrapper.findAll('[role="option"]')[0].text())
      .toContain('deepseek/deepseek-v4-flash-0731')

    await wrapper.setProps({ providerId: 'openrouter-1' })
    expect(wrapper.get('[role="combobox"]').text())
      .toContain('OpenRouter (deepseek-v4-flash-0731)')
    expect(wrapper.get('[role="combobox"]').text())
      .not.toContain('deepseek/deepseek-v4-flash-0731')

    const providerDefault = wrapper.findAll('[role="option"]')
      .find((option) => option.text().includes('OpenRouter'))!
    expect(providerDefault.text()).toContain('deepseek/deepseek-v4-flash-0731')
  })

  test('omits a chat provider default from reranker choices', async () => {
    const store = useProviderStore()
    store.listModelItems = vi.fn().mockResolvedValue([{ id: 'cohere/rerank-v3.5' }])
    const wrapper = mount(ProviderModelSelect, {
      props: {
        providerId: 'openrouter-1', modelValue: 'cohere/rerank-v3.5',
        providers: [{ id: 'openrouter-1', name: 'OpenRouter', type: 'openrouter', defaultModel: 'deepseek/deepseek-v4-flash' }],
        modelType: 'reranker', includeProviderDefault: false, onlyShowAvailableModels: true,
      },
      global: { stubs: { Icon: true } },
    })
    await flushPromises()
    await wrapper.get('[role="combobox"]').trigger('click')
    const options = wrapper.findAll('[role="option"]').map(option => option.text())
    expect(options).toContain('cohere/rerank-v3.5')
    expect(options.join(' ')).not.toContain('deepseek')
  })

  test('colors image pricing green and transcription pricing blue', async () => {
    const store = useProviderStore()
    store.listModelItems = vi.fn().mockImplementation(async (_providerId, type) => {
      if (type === 'image') return [{
        id: 'image/model', outputModalities: ['image'], pricing: { image: 0.04 },
      }]
      if (type === 'transcription') return [{
        id: 'transcription/model', outputModalities: ['transcription'],
        pricing: { skus: { per_audio_minute: 0.0015 } },
      }]
      return []
    })

    const wrapper = mount(ProviderModelSelect, {
      props: {
        providerId: 'color-provider',
        modelValue: '',
        providers: [{ id: 'color-provider', name: 'OpenRouter', type: 'openrouter', defaultModel: '' }],
        modelTypes: ['image', 'transcription'],
      },
      global: { stubs: { Icon: true } },
    })
    await flushPromises()
    await wrapper.get('[role="combobox"]').trigger('click')

    const image = wrapper.findAll('[role="option"]')
      .find((row) => (row.attributes('data-value') || '').includes('image/model'))!
    const transcription = wrapper.findAll('[role="option"]')
      .find((row) => (row.attributes('data-value') || '').includes('transcription/model'))!
    expect(image.html()).toContain('bg-emerald-500/10')
    expect(transcription.html()).toContain('bg-blue-500/10')
  })

  test('does not let another mounted selector overwrite a versioned favorite', async () => {
    localStorage.setItem(SK_PROVIDER_MODEL_FAVORITES, JSON.stringify([{
      providerId: 'deepseek-provider',
      model: 'deepseek-v4-flash',
      modelType: 'llm',
      label: 'deepseek-v4-flash',
    }]))

    const store = useProviderStore()
    store.listModelItems = vi.fn().mockResolvedValue([
      { id: 'deepseek-v4-flash' },
      { id: 'deepseek-v4-flash-0731' },
      { id: 'another-model' },
    ])
    const mountSelector = () => mount(ProviderModelSelect, {
      props: {
        providerId: 'deepseek-provider',
        modelValue: '',
        providers: [{
          id: 'deepseek-provider',
          name: 'DeepSeek',
          type: 'openai',
          defaultModel: 'deepseek-v4-flash',
        }],
      },
      global: { stubs: { Icon: true } },
    })

    const first = mountSelector()
    const second = mountSelector()
    await flushPromises()

    await first.get('[role="combobox"]').trigger('click')
    const versionedRow = first.findAll('[role="option"]')
      .find((option) => option.text().includes('deepseek-v4-flash-0731'))!
    await versionedRow.get('[aria-label="Add to favorites"]').trigger('click')

    await second.get('[role="combobox"]').trigger('click')
    const syncedVersionedRow = second.findAll('[role="option"]')
      .find((option) => option.text().includes('deepseek-v4-flash-0731'))!
    expect(syncedVersionedRow.get('[role="button"]').attributes('aria-label'))
      .toBe('Remove from favorites')

    const anotherRow = second.findAll('[role="option"]')
      .find((option) => option.text().includes('another-model'))!
    await anotherRow.get('[aria-label="Add to favorites"]').trigger('click')

    const storedModels = JSON.parse(
      localStorage.getItem(SK_PROVIDER_MODEL_FAVORITES) || '[]',
    ).map((favorite: { model: string }) => favorite.model)
    expect(storedModels).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-flash-0731',
      'another-model',
    ])

    first.unmount()
    second.unmount()
  })

  test('renders a small window of a large model list and still finds distant models', async () => {
    const store = useProviderStore()
    store.listModelItems = vi.fn().mockResolvedValue(
      Array.from({ length: 1000 }, (_, index) => ({ id: `model-${String(index).padStart(4, '0')}` })),
    )
    const wrapper = mount(ProviderModelSelect, {
      props: {
        providerId: 'large-provider', modelValue: '',
        providers: [{ id: 'large-provider', name: 'Large Provider', type: 'openai', defaultModel: '' }],
      },
      global: { stubs: { Icon: true } },
    })
    await flushPromises()
    await wrapper.get('[role="combobox"]').trigger('click')
    expect(wrapper.findAll('[role="option"]').length).toBeLessThan(50)

    const scroller = wrapper.get('.custom-select-options')
    ;(scroller.element as HTMLElement).scrollTop = 900 * 32
    await scroller.trigger('scroll')
    expect(wrapper.text()).toContain('model-0900')
    expect(wrapper.findAll('[role="option"]').length).toBeLessThan(50)

    await wrapper.get('input[placeholder="Search…"]').setValue('model-0999')
    expect(wrapper.findAll('[role="option"]')).toHaveLength(1)
    await wrapper.get('[role="option"]').trigger('click')
    expect(wrapper.emitted('change')?.[0]).toEqual([{ providerId: 'large-provider', model: 'model-0999' }])
    wrapper.unmount()
  })

  test('keeps a minimum-width dropdown stable as virtual rows change', async () => {
    const store = useProviderStore()
    store.listModelItems = vi.fn().mockResolvedValue([{ id: 'short' }, { id: 'a-much-longer-model-name' }])
    const wrapper = mount(ProviderModelSelect, {
      props: {
        providerId: 'width-provider', modelValue: '', dropdownWidth: 'min-w-full',
        providers: [{ id: 'width-provider', name: 'Provider', type: 'openai', defaultModel: '' }],
      },
      global: { stubs: { Icon: true } },
    })
    await flushPromises()
    await wrapper.get('[role="combobox"]').trigger('click')
    const dropdown = wrapper.get('[role="listbox"]')
    expect(dropdown.classes()).toContain('min-w-full')
    expect(dropdown.classes()).toContain('w-96')
    expect(dropdown.classes()).toContain('max-w-[calc(100vw-2rem)]')
    wrapper.unmount()
  })
})
