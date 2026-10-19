import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { beforeEach, expect, test, vi } from 'vitest'
import ChatHeaderBar from './ChatHeaderBar.vue'

const mocks = vi.hoisted(() => ({ renameConversation: vi.fn(), setIncognito: vi.fn(), saveActiveConversation: vi.fn() }))
const chatStore = reactive({
  activeConversationId: 'chat-1' as string | null,
  activeConversation: { id: 'chat-1', title: 'Original title' },
  activeAgentId: null,
  activeIsTemporary: false,
  messages: [] as unknown[],
  renameConversation: mocks.renameConversation,
  setIncognito: mocks.setIncognito,
  saveActiveConversation: mocks.saveActiveConversation,
})

vi.mock('../../stores/chat.store', () => ({ useChatStore: () => chatStore }))
vi.mock('../../stores/provider.store', () => ({ useProviderStore: () => ({}) }))
vi.mock('../../stores/agent-definitions.store', () => ({ useAgentDefinitionsStore: () => ({ agents: [] }) }))
vi.mock('../../stores/cyno.store', () => ({ useCynoStore: () => ({ name: 'Cyno' }) }))

beforeEach(() => {
  chatStore.activeConversationId = 'chat-1'
  chatStore.activeConversation = { id: 'chat-1', title: 'Original title' }
  chatStore.activeIsTemporary = false
  chatStore.messages = []
  mocks.setIncognito.mockReset()
  mocks.saveActiveConversation.mockReset().mockResolvedValue(undefined)
  mocks.renameConversation.mockReset()
  mocks.renameConversation.mockImplementation(async (id: string, title: string) => {
    if (chatStore.activeConversation.id === id) chatStore.activeConversation.title = title
  })
})

function render() {
  return mount(ChatHeaderBar, {
    attachTo: document.body,
    props: { hasPlanningTasks: false, taskListOpen: false, planningTaskCount: 0 },
    global: { stubs: { AgentSelect: true, ChatSettingsMenu: true } },
  })
}

const titleInput = 'input[aria-label="Conversation title"]'
const renameButton = 'button[aria-label="Rename chat"]'

test('clicking the title selects it and Enter saves the trimmed title once', async () => {
  const wrapper = render()
  await wrapper.get(renameButton).trigger('click')
  const input = wrapper.get<HTMLInputElement>(titleInput)
  expect(document.activeElement).toBe(input.element)
  expect(input.element.selectionStart).toBe(0)
  expect(input.element.selectionEnd).toBe('Original title'.length)

  await input.setValue('  Renamed chat  ')
  await input.trigger('keydown', { key: 'Enter' })
  await input.trigger('blur')
  await flushPromises()

  expect(mocks.renameConversation).toHaveBeenCalledExactlyOnceWith('chat-1', 'Renamed chat')
  expect(wrapper.get(renameButton).text()).toBe('Renamed chat')
  expect(document.activeElement).toBe(wrapper.get(renameButton).element)
})

test('clicking away saves the edited title', async () => {
  const wrapper = render()
  await wrapper.get(renameButton).trigger('click')
  await wrapper.get(titleInput).setValue('Saved on blur')
  await wrapper.get(titleInput).trigger('blur')
  await flushPromises()
  expect(mocks.renameConversation).toHaveBeenCalledExactlyOnceWith('chat-1', 'Saved on blur')
  expect(wrapper.get(renameButton).text()).toBe('Saved on blur')
})

test('Escape cancels without saving, including a subsequent blur', async () => {
  const wrapper = render()
  await wrapper.get(renameButton).trigger('click')
  const input = wrapper.get(titleInput)
  await input.setValue('Discard this')
  await input.trigger('keydown', { key: 'Escape' })
  await input.trigger('blur')
  await flushPromises()
  expect(mocks.renameConversation).not.toHaveBeenCalled()
  expect(wrapper.get(renameButton).text()).toBe('Original title')
  expect(document.activeElement).toBe(wrapper.get(renameButton).element)
})

test.each(['   ', '  Original title  '])('ignores blank or unchanged titles (%j)', async (title) => {
  const wrapper = render()
  await wrapper.get(renameButton).trigger('click')
  await wrapper.get(titleInput).setValue(title)
  await wrapper.get(titleInput).trigger('keydown', { key: 'Enter' })
  expect(mocks.renameConversation).not.toHaveBeenCalled()
  expect(wrapper.get(renameButton).text()).toBe('Original title')
})

test('switching chats discards an unfinished rename', async () => {
  const wrapper = render()
  await wrapper.get(renameButton).trigger('click')
  const input = wrapper.get(titleInput)
  await input.setValue('Unfinished edit')
  chatStore.activeConversationId = 'chat-2'
  chatStore.activeConversation = { id: 'chat-2', title: 'Another chat' }
  await input.trigger('blur')
  expect(mocks.renameConversation).not.toHaveBeenCalled()
  expect(wrapper.find(titleInput).exists()).toBe(false)
  expect(wrapper.get(renameButton).text()).toBe('Another chat')
})

test('shows a failed save and allows retrying', async () => {
  mocks.renameConversation.mockRejectedValueOnce(new Error('Network error'))
  const wrapper = render()
  await wrapper.get(renameButton).trigger('click')
  await wrapper.get(titleInput).setValue('New title')
  await wrapper.get(titleInput).trigger('keydown', { key: 'Enter' })
  await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain('Could not rename chat')
  expect(wrapper.get(renameButton).text()).toBe('Original title')

  await wrapper.get(renameButton).trigger('click')
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  await wrapper.get(titleInput).setValue('New title')
  await wrapper.get(titleInput).trigger('keydown', { key: 'Enter' })
  await flushPromises()
  expect(wrapper.get(renameButton).text()).toBe('New title')
})

const incognitoToggle = 'button[aria-label="Incognito chat"]'
const saveButton = 'button[aria-label="Save chat to history"]'

test('an empty new chat offers the incognito toggle', async () => {
  chatStore.activeConversationId = null
  const wrapper = render()
  const toggle = wrapper.get(incognitoToggle)
  expect(toggle.attributes('aria-pressed')).toBe('false')
  await toggle.trigger('click')
  expect(mocks.setIncognito).toHaveBeenCalledExactlyOnceWith(true)
  expect(wrapper.find(saveButton).exists()).toBe(false)
})

test('a saved chat shows neither the incognito toggle nor Save', () => {
  const wrapper = render()
  expect(wrapper.find(incognitoToggle).exists()).toBe(false)
  expect(wrapper.find(saveButton).exists()).toBe(false)
  expect(wrapper.text()).not.toContain('Incognito')
})

test('an incognito chat with messages can be saved to the history', async () => {
  chatStore.activeIsTemporary = true
  const wrapper = render()
  expect(wrapper.find(incognitoToggle).exists()).toBe(false)
  expect(wrapper.text()).toContain('Incognito')
  await wrapper.get(saveButton).trigger('click')
  await flushPromises()
  expect(mocks.saveActiveConversation).toHaveBeenCalledOnce()
})
