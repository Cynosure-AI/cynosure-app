import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { SK_CHAT_DRAFT_PREFIX } from '../../utils/storage-keys'
import InputBar from './InputBar.vue'
import { api } from '../../api/client'

const chatStore = reactive({
  activeConversationId: 'conversation-1' as string | null,
  activeAgentId: 'agent-1' as string | null,
  isConversationLocked: false,
  queuedMessages: [] as Array<{ id: string; content: string; attachments: unknown[] }>,
  modelModalities: null as { input: string[]; output: string[] } | null,
  sendMessage: vi.fn<(...args: unknown[]) => Promise<void>>(),
  queueMessage: vi.fn<(...args: unknown[]) => Promise<void>>(),
  updateQueuedMessage: vi.fn<(...args: unknown[]) => Promise<void>>(),
  removeQueuedMessage: vi.fn(),
  removeQueuedAttachment: vi.fn(),
  steerQueuedMessage: vi.fn(),
  runNextQueuedMessage: vi.fn(),
  createConversation: vi.fn<() => Promise<string>>(),
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
        FileLibraryModal: true,
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
    chatStore.queuedMessages = []
    chatStore.sendMessage.mockReset()
    chatStore.sendMessage.mockResolvedValue()
    chatStore.queueMessage.mockReset()
    chatStore.queueMessage.mockResolvedValue()
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

  test('auto-sizes the composer when restoring a saved draft', () => {
    const draftKey = `${SK_CHAT_DRAFT_PREFIX}conversation:conversation-1`
    localStorage.setItem(draftKey, 'A restored draft that spans multiple lines')
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(120)

    const wrapper = mountInputBar()

    expect(wrapper.get<HTMLTextAreaElement>('textarea').element.style.height).toBe('120px')
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

  test('queues Enter submissions while a conversation is running', async () => {
    chatStore.isConversationLocked = true
    const wrapper = mountInputBar()
    await wrapper.get('textarea').setValue('Do this next')

    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(chatStore.queueMessage).toHaveBeenCalledWith('Do this next', 'next', undefined, undefined, undefined)
    expect(chatStore.sendMessage).not.toHaveBeenCalled()
  })

  test('uses the secondary composer action for steering', async () => {
    chatStore.isConversationLocked = true
    const wrapper = mountInputBar()
    await wrapper.get('textarea').setValue('Change direction')

    wrapper.findComponent({ name: 'InputToolbar' }).vm.$emit('steer')
    await flushPromises()

    expect(chatStore.queueMessage).toHaveBeenCalledWith('Change direction', 'steer', undefined, undefined, undefined)
  })

  test('adds a reused library file to the next message', async () => {
    const wrapper = mountInputBar()
    const toolbar = wrapper.findComponent({ name: 'InputToolbar' })
    toolbar.vm.$emit('browseLibrary')
    await flushPromises()

    const library = wrapper.findComponent({ name: 'FileLibraryModal' })
    expect(library.props('show')).toBe(true)
    library.vm.$emit('add', {
      images: [],
      files: [{ id: 'upload-1', name: 'notes.txt', content: 'saved notes' }],
      audio: [],
    })
    await wrapper.get('textarea').setValue('Use this again')
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(chatStore.sendMessage).toHaveBeenCalledWith(
      'Use this again',
      undefined,
      [{ name: 'notes.txt', content: 'saved notes' }],
      undefined,
    )
  })

  test('adds generated image and audio artifacts to the next message', async () => {
    const wrapper = mountInputBar()
    const library = wrapper.findComponent({ name: 'FileLibraryModal' })
    library.vm.$emit('add', {
      images: [{ id: 'image-artifact', name: 'concept.png', url: 'data:image/png;base64,image' }],
      files: [],
      audio: [{ id: 'audio-artifact', name: 'voice.wav', url: 'data:audio/wav;base64,audio' }],
    })
    await wrapper.get('textarea').setValue('Use these artifacts')
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(chatStore.sendMessage).toHaveBeenCalledWith(
      'Use these artifacts',
      ['data:image/png;base64,image'],
      undefined,
      ['data:audio/wav;base64,audio'],
    )
  })

  test('re-enables sending when attachment preprocessing completes', async () => {
    let finish!: (value: { id: string; name: string; chunkCount: number }) => void
    const stage = vi.spyOn(api.chat, 'stageAttachment').mockReturnValue(new Promise(resolve => { finish = resolve }))
    const wrapper = mountInputBar()
    await wrapper.get('textarea').setValue('Read this')

    wrapper.vm.processFiles([new File(['notes'], 'notes.txt', { type: 'text/plain' })])
    await vi.waitFor(() => {
      expect(wrapper.findComponent({ name: 'InputToolbar' }).props('canSend')).toBe(false)
    })

    finish({ id: 'staged-1', name: 'notes.txt', chunkCount: 1 })
    await flushPromises()
    expect(wrapper.findComponent({ name: 'InputToolbar' }).props('canSend')).toBe(true)

    stage.mockRestore()
  })
})
