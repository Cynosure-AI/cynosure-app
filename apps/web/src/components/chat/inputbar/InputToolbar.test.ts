import { flushPromises, mount } from '@vue/test-utils'
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
  setSessionModel: vi.fn(),
}))

vi.mock('../../../stores/chat.store', () => ({ useChatStore: () => chat }))
vi.mock('../../../stores/preferences.store', () => ({ usePreferencesStore: () => ({ whisperEnabled: false }) }))
vi.mock('../../../stores/agent-definitions.store', () => ({ useAgentDefinitionsStore: () => ({ get: () => null }) }))
vi.mock('../../../stores/provider.store', () => ({ useProviderStore: () => ({
  lastUsedProviderId: 'provider',
  providers: [{ id: 'provider', name: 'Provider', type: 'openai', defaultModel: 'test-model' }],
  listModelItems: vi.fn(async () => [{ id: 'test-model', inputModalities: ['text'] }]),
  setLastUsed: vi.fn(),
}) }))
vi.mock('../../../composables/useWhisper', () => ({ useWhisper: () => ({
  status: { value: 'idle' }, progress: { value: 0 }, downloadedModels: { value: [] },
  startRecording: vi.fn(), stopRecording: vi.fn(),
}) }))

import InputToolbar from './InputToolbar.vue'
import HoverTooltip from '../../shared/HoverTooltip.vue'
import { api } from '../../../api/client'

beforeEach(() => {
  vi.clearAllMocks()
  chat.activeConversationHasRunningInstance = true
})

test('the visible Stop button always requests chat cancellation', async () => {
  const wrapper = mount(InputToolbar, {
    props: { canSend: false, hasInput: false, isRunning: true, editingQueue: false },
    global: { stubs: {
      Icon: true, HoverMenu: true, HoverTooltip: true, ProviderModelSelect: true,
      SplitButton: true, ModelSelectorModal: true, ChatOptionsMenu: true, ThinkingModeButton: true,
    } },
  })
  await wrapper.get('[aria-label="Stop current response"]').trigger('click')
  expect(chat.cancelStream).toHaveBeenCalledOnce()
})

function mountRunning(props: { canSend: boolean; hasInput: boolean; editingQueue?: boolean }) {
  return mount(InputToolbar, {
    props: { isRunning: true, editingQueue: false, ...props },
    global: { stubs: {
      Icon: true, HoverMenu: true, HoverTooltip: true, ProviderModelSelect: true,
      ModelSelectorModal: true, ChatOptionsMenu: true, ThinkingModeButton: true,
    } },
  })
}

test('while running, an empty input offers Stop and no Queue', () => {
  const wrapper = mountRunning({ canSend: false, hasInput: false })
  expect(wrapper.find('[aria-label="Stop current response"]').exists()).toBe(true)
  expect(wrapper.find('[aria-label="Queue message for next turn"]').exists()).toBe(false)
})

test('while running, typing turns Stop into Queue and clearing the input turns it back', async () => {
  const wrapper = mountRunning({ canSend: true, hasInput: true })
  expect(wrapper.find('[aria-label="Stop current response"]').exists()).toBe(false)
  await wrapper.get('[aria-label="Queue message for next turn"]').trigger('click')
  expect(wrapper.emitted('send')).toHaveLength(1)

  await wrapper.setProps({ canSend: false, hasInput: false })
  expect(wrapper.find('[aria-label="Stop current response"]').exists()).toBe(true)
  expect(wrapper.find('[aria-label="Queue message for next turn"]').exists()).toBe(false)
})

test('while running, a message that cannot be sent yet shows a disabled Queue', () => {
  const wrapper = mountRunning({ canSend: false, hasInput: true })
  expect(wrapper.find('[aria-label="Stop current response"]').exists()).toBe(false)
  expect(wrapper.get('[aria-label="Queue message for next turn"]').attributes('disabled')).toBeDefined()
})

test('places thinking effort immediately before the model selectors', () => {
  const wrapper = mount(InputToolbar, {
    props: { canSend: false, hasInput: false, isRunning: false, editingQueue: false },
    global: { stubs: {
      Icon: true, HoverMenu: true, HoverTooltip: true, ProviderModelSelect: true,
      SplitButton: true, ModelSelectorModal: true, ChatOptionsMenu: true, ThinkingModeButton: true,
    } },
  })
  const button = wrapper.find('thinking-mode-button-stub').element
  expect(button.nextElementSibling?.getAttribute('aria-label')).toBe('Select provider and model')
  expect(button.nextElementSibling?.nextElementSibling?.classList.contains('lg:flex')).toBe(true)
})

test.each(['toggle', 'escape', 'outside', 'selection'])('hides model details while the dropdown is open and restores them after %s', async (closeMethod) => {
  vi.spyOn(api.modelFavorites, 'get').mockResolvedValue({ favorites: [], initialized: true })
  const wrapper = mount(InputToolbar, {
    attachTo: document.body,
    props: { canSend: false, hasInput: false, isRunning: false, editingQueue: false },
    global: { stubs: {
      SplitButton: true, ModelSelectorModal: true, ChatOptionsMenu: true, ThinkingModeButton: true,
    } },
  })
  await flushPromises()

  const tooltipTrigger = wrapper.findComponent(HoverTooltip).get('.inline-flex')
  await tooltipTrigger.trigger('mouseenter')
  expect(document.body.textContent).toContain('Capabilities')

  const selector = wrapper.get('[role="combobox"]')
  await selector.trigger('click')
  expect(wrapper.find('[role="listbox"]').exists()).toBe(true)
  await wrapper.get('[role="option"]').trigger('mouseenter')
  expect(document.body.textContent).not.toContain('Capabilities')

  if (closeMethod === 'toggle') await selector.trigger('click')
  else if (closeMethod === 'escape') await wrapper.get('input[placeholder="Search…"]').trigger('keydown', { key: 'Escape' })
  else if (closeMethod === 'outside') {
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await flushPromises()
  } else await wrapper.get('[role="option"]').trigger('click')

  expect(wrapper.find('[role="listbox"]').exists()).toBe(false)
  await tooltipTrigger.trigger('mouseleave')
  await tooltipTrigger.trigger('mouseenter')
  expect(document.body.textContent).toContain('Capabilities')
  wrapper.unmount()
})
