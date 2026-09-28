import { mount } from '@vue/test-utils'
import { beforeEach, expect, test, vi } from 'vitest'

const chat = vi.hoisted(() => ({
  activeConversationHasRunningInstance: true,
  activeAgentId: null,
  sessionProviderOverride: null,
  sessionModelOverride: null,
  modelPricing: null,
  modelModalities: null,
  modelInfoStatus: 'idle',
  resolvedModelProvider: null,
  cancelStream: vi.fn(async () => undefined),
}))

vi.mock('../../../stores/chat.store', () => ({ useChatStore: () => chat }))
vi.mock('../../../stores/preferences.store', () => ({ usePreferencesStore: () => ({ whisperEnabled: false }) }))
vi.mock('../../../stores/agent-definitions.store', () => ({ useAgentDefinitionsStore: () => ({ get: () => null }) }))
vi.mock('../../../stores/provider.store', () => ({ useProviderStore: () => ({ lastUsedProviderId: 'provider', providers: [] }) }))
vi.mock('../../../composables/useWhisper', () => ({ useWhisper: () => ({
  status: { value: 'idle' }, progress: { value: 0 }, downloadedModels: { value: [] },
  startRecording: vi.fn(), stopRecording: vi.fn(),
}) }))

import InputToolbar from './InputToolbar.vue'

beforeEach(() => {
  vi.clearAllMocks()
  chat.activeConversationHasRunningInstance = true
})

test('the visible Stop button always requests chat cancellation', async () => {
  const wrapper = mount(InputToolbar, {
    props: { canSend: false, isRunning: true, editingQueue: false },
    global: { stubs: {
      Icon: true, HoverMenu: true, HoverTooltip: true, ProviderModelSelect: true,
      SplitButton: true, ModelSelectorModal: true, ChatOptionsMenu: true, ThinkingModeButton: true,
    } },
  })
  await wrapper.get('[aria-label="Stop current response"]').trigger('click')
  expect(chat.cancelStream).toHaveBeenCalledOnce()
})

test('places thinking effort immediately before the model selectors', () => {
  const wrapper = mount(InputToolbar, {
    props: { canSend: false, isRunning: false, editingQueue: false },
    global: { stubs: {
      Icon: true, HoverMenu: true, HoverTooltip: true, ProviderModelSelect: true,
      SplitButton: true, ModelSelectorModal: true, ChatOptionsMenu: true, ThinkingModeButton: true,
    } },
  })
  const button = wrapper.find('thinking-mode-button-stub').element
  expect(button.nextElementSibling?.getAttribute('aria-label')).toBe('Select provider and model')
  expect(button.nextElementSibling?.nextElementSibling?.classList.contains('lg:flex')).toBe(true)
})
