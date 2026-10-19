import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { beforeEach, expect, test, vi } from 'vitest'
import ChatSettingsMenu from './ChatSettingsMenu.vue'

const chatStore = reactive({
  activeConversationId: null as string | null,
  activeConversation: null,
  activeAgentId: null as string | null,
  activeProjectId: null as string | null,
  hasAgentOverrides: false,
  hasCynoOverrides: false,
  agentOverrideFields: [] as string[],
  cynoOverrideFields: [] as string[],
  selectedToolNames: [] as string[],
  sessionSubAgentIds: [] as string[],
  sessionSystemPrompt: '',
  resetToDefaults: vi.fn(async () => {}),
})

vi.mock('../../stores/chat.store', () => ({ useChatStore: () => chatStore }))
vi.mock('../../stores/provider.store', () => ({ useProviderStore: () => ({ providers: [] }) }))
vi.mock('../../stores/agent-definitions.store', () => ({ useAgentDefinitionsStore: () => ({ get: () => null }) }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

beforeEach(() => {
  chatStore.activeConversationId = null
  chatStore.activeProjectId = null
  chatStore.hasCynoOverrides = false
  chatStore.cynoOverrideFields = []
  chatStore.resetToDefaults.mockClear()
})

function render() {
  return mount(ChatSettingsMenu, {
    attachTo: document.body,
    global: { stubs: { Icon: true, ModalDialog: true } },
  })
}

function resetButton() {
  return [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.textContent?.includes('Reset to Defaults'))
}

test('a selected project does not mark the settings as changed, but reset still removes it', async () => {
  chatStore.activeProjectId = 'project-1'
  const wrapper = render()

  expect(wrapper.find('[aria-label="Unsaved configuration changes"]').exists()).toBe(false)
  await wrapper.get('[aria-label="Chat / Agent Settings"]').trigger('click')
  expect(document.body.textContent).not.toContain('Changed:')

  resetButton()!.click()
  await flushPromises()
  expect(chatStore.resetToDefaults).toHaveBeenCalledOnce()
  wrapper.unmount()
})

test('settings changes still show the dot', async () => {
  chatStore.hasCynoOverrides = true
  chatStore.cynoOverrideFields = ['Tools']
  const wrapper = render()

  expect(wrapper.find('[aria-label="Unsaved configuration changes"]').exists()).toBe(true)
  await wrapper.get('[aria-label="Chat / Agent Settings"]').trigger('click')
  expect(document.body.textContent).toContain('Changed: Tools')
  expect(resetButton()).toBeDefined()
  wrapper.unmount()
})
