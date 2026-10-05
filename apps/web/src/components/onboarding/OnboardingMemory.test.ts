import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, test, vi } from 'vitest'
import OnboardingMemory from './OnboardingMemory.vue'

const mocks = vi.hoisted(() => ({
  getEmbeddingConfig: vi.fn(),
  configureEmbeddings: vi.fn(),
  listModels: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  api: { memory: { getEmbeddingConfig: mocks.getEmbeddingConfig, configureEmbeddings: mocks.configureEmbeddings } },
}))
vi.mock('../../stores/provider.store', () => ({
  useProviderStore: () => ({
    providers: [{ id: 'local', name: 'LM Studio', type: 'lmstudio' }],
    lastUsedProviderId: 'local',
    loadProviders: async () => undefined,
    listModels: mocks.listModels,
  }),
}))

type MemoryStep = { save: () => Promise<boolean> }

beforeEach(() => {
  mocks.getEmbeddingConfig.mockReset().mockResolvedValue({ providerId: null, model: '', dimensions: 0 })
  mocks.configureEmbeddings.mockReset()
  mocks.listModels.mockReset().mockResolvedValue(['embed-small'])
})

test('the preselected embedding model is reported as unsaved and saved on Continue', async () => {
  mocks.configureEmbeddings.mockResolvedValue({ dimensions: 768 })
  const wrapper = mount(OnboardingMemory, { global: { stubs: { Icon: true } } })
  await flushPromises()

  expect(wrapper.emitted('state-change')?.at(-1)).toEqual([{ pending: true, busy: false }])
  await expect((wrapper.vm as unknown as MemoryStep).save()).resolves.toBe(true)

  expect(mocks.configureEmbeddings).toHaveBeenCalledWith({ providerId: 'local', model: 'embed-small' })
  expect(wrapper.emitted('state-change')?.at(-1)).toEqual([{ pending: false, busy: false }])
  expect(wrapper.text()).toContain('Memory embeddings are ready')
})

test('a failed save keeps the user on the step with an explanation', async () => {
  mocks.configureEmbeddings.mockRejectedValue(new Error('Model returned no vector'))
  const wrapper = mount(OnboardingMemory, { global: { stubs: { Icon: true } } })
  await flushPromises()

  await expect((wrapper.vm as unknown as MemoryStep).save()).resolves.toBe(false)
  await flushPromises()

  expect(wrapper.get('[role="alert"]').text()).toContain('Memory could not be configured: Model returned no vector')
  expect(wrapper.emitted('state-change')?.at(-1)).toEqual([{ pending: true, busy: false }])
})

test('choosing to set up memory later saves nothing', async () => {
  const wrapper = mount(OnboardingMemory, { global: { stubs: { Icon: true } } })
  await flushPromises()

  await wrapper.get('#onboarding-embedding-provider').setValue('')
  await flushPromises()

  expect(wrapper.emitted('state-change')?.at(-1)).toEqual([{ pending: false, busy: false }])
  await expect((wrapper.vm as unknown as MemoryStep).save()).resolves.toBe(true)
  expect(mocks.configureEmbeddings).not.toHaveBeenCalled()
})
