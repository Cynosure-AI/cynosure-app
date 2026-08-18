import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { SK_CHAT_DRAFT_PREFIX } from '../../utils/storage-keys'
import InputBar from './InputBar.vue'

const chatStore = reactive({
  activeConversationId: 'conversation-1' as string | null,
  activeAgentId: 'agent-1' as string | null,
  isConversationLocked: false,
  modelModalities: null as { input: string[]; output: string[] } | null,
  sendMessage: vi.fn<(...args: unknown[]) => Promise<void>>(),
})

vi.mock('../../stores/chat.store', () => ({
  useChatStore: () => chatStore,
}))

function mountInputBar() {
  return mount(InputBar, {
    global: {
      stubs: {
        InputToolbar: true,
        ContextRing: true,
        HoverTooltip: true,
      },
    },
  })
}

describe('InputBar drafts', () => {
  beforeEach(() => {
    localStorage.clear()
    chatStore.activeConversationId = 'conversation-1'
    chatStore.activeAgentId = 'agent-1'
    chatStore.isConversationLocked = false
    chatStore.sendMessage.mockReset()
    chatStore.sendMessage.mockResolvedValue()
  })

  test('restores the latest conversation draft after the composer remounts', async () => {
    const draftKey = `${SK_CHAT_DRAFT_PREFIX}conversation:conversation-1`
    const first = mountInputBar()
    await first.get('textarea').setValue('First draft')
    first.unmount()

    expect(localStorage.getItem(draftKey)).toBe('First draft')

    const second = mountInputBar()
    expect(second.get<HTMLTextAreaElement>('textarea').element.value).toBe('First draft')

    await second.get('textarea').setValue('Edited draft')
    second.unmount()

    expect(localStorage.getItem(draftKey)).toBe('Edited draft')
  })

  test('keeps separate drafts for each conversation', async () => {
    const wrapper = mountInputBar()
    await wrapper.get('textarea').setValue('Conversation one')

    chatStore.activeConversationId = 'conversation-2'
    await flushPromises()
    expect(wrapper.get<HTMLTextAreaElement>('textarea').element.value).toBe('')

    await wrapper.get('textarea').setValue('Conversation two')
    chatStore.activeConversationId = 'conversation-1'
    await flushPromises()

    expect(wrapper.get<HTMLTextAreaElement>('textarea').element.value).toBe('Conversation one')
  })

  test('clears the saved draft when the message is sent', async () => {
    const draftKey = `${SK_CHAT_DRAFT_PREFIX}conversation:conversation-1`
    localStorage.setItem(draftKey, 'Send this')
    const wrapper = mountInputBar()

    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(chatStore.sendMessage).toHaveBeenCalledWith('Send this', undefined, undefined, undefined)
    expect(localStorage.getItem(draftKey)).toBeNull()
    expect(wrapper.get<HTMLTextAreaElement>('textarea').element.value).toBe('')
  })
})
