import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import ProviderModelSelect from './ProviderModelSelect.vue'
import { useProviderStore } from '../../stores/provider.store'
import { SK_PROVIDER_MODEL_FAVORITES } from '../../utils/storage-keys'

describe('ProviderModelSelect favorites', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
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
        modelValue: '',
        providers: [{ id: 'openrouter-1', name: 'OpenRouter', type: 'openrouter', defaultModel: 'text/model' }],
        modelTypes: ['llm', 'image', 'video', 'transcription'],
      },
      global: { stubs: { Icon: true } },
    })
    await flushPromises()
    await wrapper.get('[role="combobox"]').trigger('click')
    const row = wrapper.findAll('[role="option"]').find((option) => option.text().includes('speech/model'))!
    expect(row.text()).toContain('$')
    expect(row.text()).not.toContain('Transcription')
    await row.get('[aria-label="Add to favorites"]').trigger('click')

    expect(JSON.parse(localStorage.getItem(SK_PROVIDER_MODEL_FAVORITES) || '[]')).toMatchObject([
      { providerId: 'openrouter-1', model: 'speech/model', modelType: 'transcription' },
    ])
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
})
