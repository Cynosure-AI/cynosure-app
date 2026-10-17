import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, test, vi } from 'vitest'
import ProviderForm from './ProviderForm.vue'

const mocks = vi.hoisted(() => ({ previewModels: vi.fn() }))
vi.mock('../../api/client', () => ({ api: { provider: { previewModels: mocks.previewModels } } }))
vi.mock('../../composables/useProviderLogos', () => ({ useProviderLogos: () => ({ providerLogos: {} }) }))

const stubs = { Icon: true, CustomSelect: { props: ['modelValue'], template: '<div data-test="model-select">{{ modelValue }}</div>' } }

function mountForm(props: Record<string, unknown> = {}) {
  return mount(ProviderForm, { props: { submitLabel: 'Add Provider', ...props }, global: { stubs } })
}

const submitButton = (wrapper: ReturnType<typeof mountForm>) => wrapper.get('button[type="submit"]')
const loadButton = (wrapper: ReturnType<typeof mountForm>) => wrapper.findAll('button').find((button) => button.text().includes('Load models'))!

beforeEach(() => {
  mocks.previewModels.mockReset()
})

test('a hosted provider cannot be added without an API key', async () => {
  const wrapper = mountForm()
  expect(submitButton(wrapper).attributes('disabled')).toBeDefined()
  expect(loadButton(wrapper).attributes('disabled')).toBeDefined()

  await wrapper.get('input[type="password"]').setValue('sk-test')

  expect(submitButton(wrapper).attributes('disabled')).toBeUndefined()
  await wrapper.get('form').trigger('submit')
  expect(wrapper.emitted('submit')?.[0][0]).toEqual({
    type: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', defaultModel: 'gpt-4o',
  })
})

test('a local provider needs a base URL but no API key', async () => {
  const wrapper = mountForm()
  await wrapper.get('select').setValue('ollama')

  expect(wrapper.get('input[type="url"]').element).toHaveProperty('value', 'http://localhost:11434/v1')
  expect(loadButton(wrapper).attributes('disabled')).toBeUndefined()
  // Ollama has no default model, so one must be entered first.
  expect(submitButton(wrapper).attributes('disabled')).toBeDefined()
  expect(wrapper.text()).toContain('Choose a default model.')
})

test('Unsloth Studio needs both a base URL and an API key', async () => {
  const wrapper = mountForm()
  await wrapper.get('select').setValue('unsloth')

  expect(wrapper.get('input[type="url"]').element).toHaveProperty('value', 'http://localhost:8888/v1')
  expect(wrapper.text()).not.toContain('(optional)')
  expect(loadButton(wrapper).attributes('disabled')).toBeDefined()
  expect(wrapper.text()).toContain('Enter an API key.')

  await wrapper.get('input[type="password"]').setValue('sk-unsloth-test')
  expect(loadButton(wrapper).attributes('disabled')).toBeUndefined()

  await wrapper.get('input[type="url"]').setValue('')
  expect(loadButton(wrapper).attributes('disabled')).toBeDefined()
  expect(wrapper.text()).toContain('Enter the server base URL.')
})

test('models are loaded from the unsaved draft and failures are explained', async () => {
  mocks.previewModels.mockRejectedValueOnce(new Error('401 Incorrect API key provided'))
  const wrapper = mountForm()
  await wrapper.get('input[type="password"]').setValue('sk-wrong')
  await loadButton(wrapper).trigger('click')
  await flushPromises()

  expect(mocks.previewModels).toHaveBeenCalledWith(
    { type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-wrong' },
    ['llm', 'image', 'video', 'transcription'],
  )
  expect(wrapper.get('[role="alert"]').text()).toBe('Could not load models: 401 Incorrect API key provided')

  mocks.previewModels.mockResolvedValueOnce(['gpt-4o', 'gpt-5'])
  await wrapper.get('input[type="password"]').setValue('sk-right')
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  await loadButton(wrapper).trigger('click')
  await flushPromises()
  expect(wrapper.find('[data-test="model-select"]').exists()).toBe(true)
})

test('a model list is dropped when the credentials it was loaded with change', async () => {
  mocks.previewModels.mockResolvedValueOnce(['gpt-4o'])
  const wrapper = mountForm()
  await wrapper.get('input[type="password"]').setValue('sk-one')
  await loadButton(wrapper).trigger('click')
  await flushPromises()
  expect(wrapper.find('[data-test="model-select"]').exists()).toBe(true)

  await wrapper.get('input[type="password"]').setValue('sk-two')

  expect(wrapper.find('[data-test="model-select"]').exists()).toBe(false)
})

test('editing keeps the save button disabled until something changes', async () => {
  const wrapper = mountForm({
    submitLabel: 'Save changes',
    requireChanges: true,
    initial: { type: 'openai', name: 'Work', apiKey: 'sk-saved', defaultModel: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
  })
  expect(submitButton(wrapper).attributes('disabled')).toBeDefined()
  await wrapper.get('input[autocomplete="off"][type="text"]').setValue('Work account')
  expect(submitButton(wrapper).attributes('disabled')).toBeUndefined()
  expect(wrapper.emitted('dirty-change')?.at(-1)).toEqual([true])
})

test('with auto-loading, a pasted key is checked once typing settles', async () => {
  vi.useFakeTimers()
  try {
    mocks.previewModels.mockResolvedValue(['gpt-4o', 'gpt-4o-mini'])
    const wrapper = mountForm({ autoLoadModels: true, hideType: true })
    expect(wrapper.find('select').exists()).toBe(false)
    expect(wrapper.get('a[href="https://platform.openai.com/api-keys"]').text()).toContain('Get an API key')

    await wrapper.get('input[type="password"]').setValue('sk-t')
    await wrapper.get('input[type="password"]').setValue('sk-test')
    await vi.advanceTimersByTimeAsync(600)
    await flushPromises()

    expect(mocks.previewModels).toHaveBeenCalledTimes(1)
    expect(mocks.previewModels).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-test' }), expect.anything())
    expect(wrapper.get('[role="status"]').text()).toContain('Connected · 2 models available')
  } finally {
    vi.useRealTimers()
  }
})

test('with auto-loading, a local server that is not running is explained', async () => {
  vi.useFakeTimers()
  try {
    mocks.previewModels.mockRejectedValue(new Error('fetch failed'))
    const wrapper = mountForm({ autoLoadModels: true, hideType: true, initial: { type: 'ollama' } })
    await vi.advanceTimersByTimeAsync(600)
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toBe('Could not reach Ollama at http://localhost:11434/v1. Is it running? fetch failed')
    expect(wrapper.find('a[href="https://ollama.com/download"]').exists()).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})

test('without auto-loading, models are only loaded on request', async () => {
  vi.useFakeTimers()
  try {
    const wrapper = mountForm()
    await wrapper.get('input[type="password"]').setValue('sk-test')
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.previewModels).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})
