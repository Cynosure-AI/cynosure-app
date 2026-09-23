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
vi.mock('../../../stores/provider.store', () => ({ useProviderStore: () => ({ lastUsedProviderId: '', providers: [] }) }))
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
      SplitButton: true, ToolsButton: true, SubAgentsButton: true, MemoryFoldersButton: true,
      SystemPromptButton: true, ThinkingModeButton: true, ModelSelectorModal: true,
    } },
  })
  await wrapper.get('[aria-label="Stop current response"]').trigger('click')
  expect(chat.cancelStream).toHaveBeenCalledOnce()
})
