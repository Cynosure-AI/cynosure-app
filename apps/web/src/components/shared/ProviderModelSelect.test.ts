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
    await wrapper.get('[role="combobox"]').trigger('click')

    const matchingRows = wrapper.findAll('[role="option"]')
      .filter((row) => row.text().includes('gpt-test'))
    expect(matchingRows.length).toBeGreaterThanOrEqual(2)
    expect(matchingRows[0].attributes('title')).toContain('Input / Output: $2.50 / $10.00 per 1M tokens')
    expect(matchingRows[0].text()).toContain('$2.50 / $10.00/M')
  })
})
