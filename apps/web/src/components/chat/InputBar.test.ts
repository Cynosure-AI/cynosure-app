import { flushPromises, mount } from '@vue/test-utils'
import { reactive, ref } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { SK_CHAT_DRAFT_PREFIX } from '../../utils/storage-keys'
import InputBar from './InputBar.vue'
import { api } from '../../api/client'
import { rankSlashArgs, type SlashCommand } from '../../utils/slash-commands'

const chatStore = reactive({
  activeConversationId: 'conversation-1' as string | null,
  draftDiscardRevision: 0,
  activeAgentId: 'agent-1' as string | null,
  isConversationLocked: false,
  queuedMessages: [] as Array<{ id: string; content: string; attachments: unknown[] }>,
  modelModalities: null as { input: string[]; output: string[] } | null,
  mediaGenerationSettings: null as import('@shared/types').MediaGenerationSettings | null,
  resolvedModelProvider: null as { providerId: string; model: string } | null,
  sendMessage: vi.fn<(...args: unknown[]) => Promise<void>>(),
  queueMessage: vi.fn<(...args: unknown[]) => Promise<void>>(),
  updateQueuedMessage: vi.fn<(...args: unknown[]) => Promise<void>>(),
  removeQueuedMessage: vi.fn(),
  removeQueuedAttachment: vi.fn(),
  steerQueuedMessage: vi.fn(),
  runNextQueuedMessage: vi.fn(),
  createConversation: vi.fn<() => Promise<string>>(),
  activeProjectId: null as string | null,
})
const projects = [{ id: 'project-1', name: 'Garden Planner', rootPath: '/srv/garden' }]

vi.mock('../../stores/chat.store', () => ({
  useChatStore: () => chatStore,
}))
vi.mock('../../stores/projects.store', () => ({
  useProjectsStore: () => ({ get: (id: string | null) => projects.find(project => project.id === id) }),
}))
vi.mock('../../stores/provider.store', () => ({
  useProviderStore: () => ({ providers: [{ id: 'p1', type: 'openrouter' }] }),
}))

const slashRuns = {
  autoMemory: vi.fn(() => 'Automatic memories off'),
  think: vi.fn((level: string) => `Reasoning: ${level}`),
}
const slashCommands = ref<SlashCommand[]>([])
vi.mock('../../composables/useSlashCommands', () => ({
  useSlashCommands: () => ({ commands: slashCommands, prepare: vi.fn() }),
}))

function mountInputBar(attachTo?: Element) {
  return mount(InputBar, {
    attachTo,
    global: {
      stubs: {
        InputToolbar: true,
        ContextRing: true,
        HoverTooltip: true,
        FileLibraryModal: true,
        ProjectFilePickerModal: true,
        ModelSelectorModal: true,
        SystemPromptModal: true,
      },
    },
  })
}

describe('InputBar drafts', () => {
  beforeEach(() => {
    localStorage.clear()
    chatStore.activeConversationId = 'conversation-1'
    chatStore.draftDiscardRevision = 0
    chatStore.activeAgentId = 'agent-1'
    chatStore.isConversationLocked = false
    chatStore.queuedMessages = []
    chatStore.resolvedModelProvider = null
    chatStore.modelModalities = null
    chatStore.mediaGenerationSettings = null
    chatStore.sendMessage.mockReset()
    chatStore.sendMessage.mockResolvedValue()
    chatStore.queueMessage.mockReset()
    chatStore.queueMessage.mockResolvedValue()
    chatStore.createConversation.mockReset()
    chatStore.createConversation.mockImplementation(async () => {
      chatStore.activeConversationId = 'conversation-1'
      return 'conversation-1'
    })
    vi.spyOn(api.chat, 'listStagedAttachments').mockResolvedValue([])
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

    expect(chatStore.sendMessage).toHaveBeenCalledWith('Send this', undefined, undefined, undefined, undefined)
    expect(localStorage.getItem(draftKey)).toBeNull()
    expect(wrapper.get<HTMLTextAreaElement>('textarea').element.value).toBe('')
  })

  test('loads the separate saved draft when navigating from a new chat to an existing conversation', async () => {
    chatStore.activeConversationId = null
    localStorage.setItem(`${SK_CHAT_DRAFT_PREFIX}conversation:conversation-1`, 'Existing conversation draft')
    const wrapper = mountInputBar()
    await wrapper.get('textarea').setValue('New chat draft')

    chatStore.activeConversationId = 'conversation-1'
    await flushPromises()

    expect(wrapper.get<HTMLTextAreaElement>('textarea').element.value).toBe('Existing conversation draft')
    expect(localStorage.getItem(`${SK_CHAT_DRAFT_PREFIX}new:agent-1`)).toBe('New chat draft')
  })

  test('sends selected video settings with the message', async () => {
    chatStore.resolvedModelProvider = { providerId: 'p1', model: 'video-model' }
    chatStore.modelModalities = { input: ['text', 'image'], output: ['video'] }
    const wrapper = mountInputBar()
    wrapper.findComponent({ name: 'InputToolbar' }).vm.$emit('mediaSettings', {
      kind: 'video', duration: 8, aspect_ratio: '9:16', generate_audio: false,
    })
    expect(chatStore.mediaGenerationSettings).toEqual({
      kind: 'video', duration: 8, aspect_ratio: '9:16', generate_audio: false,
    })
    await wrapper.get('textarea').setValue('A dancer in motion')
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(chatStore.sendMessage).toHaveBeenCalledWith('A dancer in motion', undefined, undefined, undefined,
      { kind: 'video', duration: 8, aspect_ratio: '9:16', generate_audio: false })
  })

  test('sends a quick response while preserving the current draft', async () => {
    const wrapper = mountInputBar(document.body)
    const textarea = wrapper.get<HTMLTextAreaElement>('textarea')
    await textarea.setValue('My unfinished draft')

    await wrapper.vm.sendSuggestion('Tell me more about that')
    await flushPromises()

    expect(chatStore.sendMessage).toHaveBeenCalledWith('Tell me more about that', undefined, undefined, undefined, undefined)
    expect(textarea.element.value).toBe('My unfinished draft')
    wrapper.unmount()
    expect(localStorage.getItem(`${SK_CHAT_DRAFT_PREFIX}conversation:conversation-1`))
      .toBe('My unfinished draft')
  })

  test('queues a quick response when the conversation is running', async () => {
    chatStore.isConversationLocked = true
    const wrapper = mountInputBar()

    await wrapper.vm.sendSuggestion('Tell me more about that')

    expect(chatStore.queueMessage).toHaveBeenCalledWith('Tell me more about that', 'next', undefined, undefined, undefined, undefined)
    expect(chatStore.sendMessage).not.toHaveBeenCalled()
  })

  test('queues Enter submissions while a conversation is running', async () => {
    chatStore.isConversationLocked = true
    const wrapper = mountInputBar()
    await wrapper.get('textarea').setValue('Do this next')

    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(chatStore.queueMessage).toHaveBeenCalledWith('Do this next', 'next', undefined, undefined, undefined, undefined)
    expect(chatStore.sendMessage).not.toHaveBeenCalled()
  })

  test('uses the secondary composer action for steering', async () => {
    chatStore.isConversationLocked = true
    const wrapper = mountInputBar()
    await wrapper.get('textarea').setValue('Change direction')

    wrapper.findComponent({ name: 'InputToolbar' }).vm.$emit('steer')
    await flushPromises()

    expect(chatStore.queueMessage).toHaveBeenCalledWith('Change direction', 'steer', undefined, undefined, undefined, undefined)
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
      undefined,
    )
  })

  test('stages project folder files and adds project images to the draft', async () => {
    chatStore.activeProjectId = 'project-1'
    const stage = vi.spyOn(api.chat, 'stageAttachment').mockResolvedValue({
      id: 'staged-1', conversationId: 'conversation-1', name: 'src/app.ts', status: 'ready', progressCurrent: 1, progressTotal: 1, chunkCount: 1,
    })
    const wrapper = mountInputBar()
    wrapper.findComponent({ name: 'InputToolbar' }).vm.$emit('browseProject')
    await flushPromises()

    const picker = wrapper.findComponent({ name: 'ProjectFilePickerModal' })
    expect(picker.props()).toMatchObject({ show: true, projectId: 'project-1', projectName: 'Garden Planner', alreadySelectedPaths: [] })
    picker.vm.$emit('add', [
      { kind: 'file', name: 'src/app.ts', content: 'export const app = 1' },
      { kind: 'image', name: 'assets/logo.png', content: 'data:image/png;base64,logo' },
    ])
    await flushPromises()

    expect(stage).toHaveBeenCalledWith('conversation-1', expect.objectContaining({ name: 'src/app.ts', content: 'export const app = 1' }), expect.anything())
    expect(picker.props('alreadySelectedPaths')).toEqual(['assets/logo.png', 'src/app.ts'])

    await wrapper.get('textarea').setValue('Review these')
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(chatStore.sendMessage).toHaveBeenCalledWith(
      'Review these',
      ['data:image/png;base64,logo'],
      [{ name: 'src/app.ts', stagedId: 'staged-1' }],
      undefined,
      undefined,
    )
    chatStore.activeProjectId = null
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
      undefined,
    )
  })

  test('re-enables sending when attachment preprocessing completes', async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.chat.stageAttachment>>) => void
    const stage = vi.spyOn(api.chat, 'stageAttachment').mockReturnValue(new Promise(resolve => { finish = resolve }))
    const wrapper = mountInputBar()
    await wrapper.get('textarea').setValue('Read this')

    wrapper.vm.processFiles([new File(['notes'], 'notes.txt', { type: 'text/plain' })])
    await vi.waitFor(() => {
      expect(wrapper.findComponent({ name: 'InputToolbar' }).props('canSend')).toBe(false)
    })

    finish({
      id: 'staged-1', conversationId: 'conversation-1', name: 'notes.txt',
      status: 'ready', progressCurrent: 1, progressTotal: 1, chunkCount: 1,
    })
    await flushPromises()
    expect(wrapper.findComponent({ name: 'InputToolbar' }).props('canSend')).toBe(true)

    stage.mockRestore()
  })

  test('preserves the new-chat draft and attachments when uploading creates a conversation', async () => {
    chatStore.activeConversationId = null
    let finish!: (value: Awaited<ReturnType<typeof api.chat.stageAttachment>>) => void
    const stage = vi.spyOn(api.chat, 'stageAttachment').mockReturnValue(new Promise(resolve => { finish = resolve }))
    let progress!: Parameters<typeof api.chat.onAttachmentStageProgress>[0]
    vi.spyOn(api.chat, 'onAttachmentStageProgress').mockImplementation(callback => {
      progress = callback
      return () => {}
    })
    const wrapper = mountInputBar()
    await wrapper.get('textarea').setValue('Read this document and summarize it')

    wrapper.vm.processFiles([new File(['notes'], 'notes.txt', { type: 'text/plain' })])
    await vi.waitFor(() => expect(stage).toHaveBeenCalled())
    await flushPromises()

    expect(chatStore.createConversation).toHaveBeenCalledTimes(1)
    expect(wrapper.get<HTMLTextAreaElement>('textarea').element.value).toBe('Read this document and summarize it')
    expect(wrapper.text()).toContain('notes.txt')
    expect(wrapper.findComponent({ name: 'InputToolbar' }).props('canSend')).toBe(false)
    expect(localStorage.getItem(`${SK_CHAT_DRAFT_PREFIX}new:agent-1`)).toBeNull()
    expect(localStorage.getItem(`${SK_CHAT_DRAFT_PREFIX}conversation:conversation-1`)).toBe('Read this document and summarize it')

    const staged = {
      id: 'staged-new-chat', conversationId: 'conversation-1', name: 'notes.txt',
      status: 'processing' as const, progressCurrent: 1, progressTotal: 2, chunkCount: 0,
    }
    finish(staged)
    await flushPromises()
    progress({ ...staged, status: 'ready', progressCurrent: 2, chunkCount: 2 })
    await flushPromises()

    expect(wrapper.get<HTMLTextAreaElement>('textarea').element.value).toBe('Read this document and summarize it')
    expect(wrapper.findComponent({ name: 'InputToolbar' }).props('canSend')).toBe(true)
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(chatStore.sendMessage).toHaveBeenCalledWith(
      'Read this document and summarize it', undefined,
      [{ name: 'notes.txt', content: undefined, stagedId: 'staged-new-chat', existingAttachmentId: undefined }],
      undefined, undefined,
    )
    wrapper.unmount()
  })

  test('restores server-side attachment indexing progress after remounting', async () => {
    vi.mocked(api.chat.listStagedAttachments).mockResolvedValue([{
      id: 'staged-1', conversationId: 'conversation-1', clientId: 'client-1', name: 'large.pdf',
      status: 'processing', progressCurrent: 7, progressTotal: 20, chunkCount: 0,
    }])

    const wrapper = mountInputBar()
    await flushPromises()

    expect(wrapper.text()).toContain('large.pdf')
    expect(wrapper.text()).toContain('7 / 20 chunks')
    expect(wrapper.findComponent({ name: 'InputToolbar' }).props('canSend')).toBe(false)
    wrapper.unmount()
  })

  test('keeps an in-flight backend staging job when navigating to another conversation', async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.chat.stageAttachment>>) => void
    vi.spyOn(api.chat, 'stageAttachment').mockReturnValue(new Promise(resolve => { finish = resolve }))
    const remove = vi.spyOn(api.chat, 'removeStagedAttachment').mockResolvedValue({ success: true })
    const wrapper = mountInputBar()

    wrapper.vm.processFiles([new File(['large notes'], 'large.txt', { type: 'text/plain' })])
    await vi.waitFor(() => expect(wrapper.text()).toContain('large.txt'))
    chatStore.activeConversationId = 'conversation-2'
    await flushPromises()
    finish({
      id: 'staged-navigation', conversationId: 'conversation-1', name: 'large.txt',
      status: 'processing', progressCurrent: 1, progressTotal: 10, chunkCount: 0,
    })
    await flushPromises()

    expect(remove).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  test('does not restore a removed upload from a stale polling response or progress event', async () => {
    const staged = {
      id: 'removed-1', conversationId: 'conversation-1', clientId: 'removed-client', name: 'removed.txt',
      status: 'ready' as const, progressCurrent: 1, progressTotal: 1, chunkCount: 1,
    }
    let progress!: Parameters<typeof api.chat.onAttachmentStageProgress>[0]
    vi.spyOn(api.chat, 'onAttachmentStageProgress').mockImplementation(callback => {
      progress = callback
      return () => {}
    })
    vi.mocked(api.chat.listStagedAttachments).mockResolvedValue([staged])
    vi.spyOn(api.chat, 'removeStagedAttachment').mockResolvedValue({ success: true })
    const wrapper = mountInputBar()
    await flushPromises()
    await wrapper.get('button[aria-label="Remove removed.txt"]').trigger('click')
    progress(staged)
    chatStore.activeConversationId = 'conversation-2'
    await flushPromises()
    chatStore.activeConversationId = 'conversation-1'
    await flushPromises()
    expect(wrapper.text()).not.toContain('removed.txt')
    wrapper.unmount()
  })

  test('New Chat discards an in-flight upload when its response arrives late', async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.chat.stageAttachment>>) => void
    const stage = vi.spyOn(api.chat, 'stageAttachment').mockReturnValue(new Promise(resolve => { finish = resolve }))
    const remove = vi.spyOn(api.chat, 'removeStagedAttachment').mockResolvedValue({ success: true })
    const wrapper = mountInputBar()
    wrapper.vm.processFiles([new File(['draft'], 'discarded.txt', { type: 'text/plain' })])
    await vi.waitFor(() => expect(stage).toHaveBeenCalled())
    chatStore.draftDiscardRevision++
    chatStore.activeConversationId = null
    await flushPromises()
    finish({ id: 'discarded-1', conversationId: 'conversation-1', name: 'discarded.txt', status: 'ready', progressCurrent: 1, progressTotal: 1, chunkCount: 1 })
    await flushPromises()
    expect(remove).toHaveBeenCalledWith('conversation-1', 'discarded-1')
    expect(wrapper.text()).not.toContain('discarded.txt')
    wrapper.unmount()
  })
})

describe('InputBar slash commands', () => {
  beforeEach(() => {
    localStorage.clear()
    chatStore.activeConversationId = 'conversation-1'
    chatStore.isConversationLocked = false
    chatStore.queuedMessages = []
    chatStore.sendMessage.mockReset()
    chatStore.sendMessage.mockResolvedValue()
    slashRuns.autoMemory.mockClear()
    slashRuns.think.mockClear()
    slashCommands.value = [
      { name: 'auto-memory', description: 'Retrieve relevant memories automatically', icon: 'x', group: 'Settings', run: slashRuns.autoMemory },
      {
        name: 'think',
        description: 'Set the reasoning level',
        icon: 'x',
        group: 'Settings',
        hint: 'level',
        args: query => rankSlashArgs(['low', 'high'].map(level => ({ key: level, label: level, run: () => slashRuns.think(level) })), query),
      },
    ]
    vi.spyOn(api.chat, 'listStagedAttachments').mockResolvedValue([])
  })

  function options(wrapper: ReturnType<typeof mountInputBar>): string[] {
    return wrapper.findAll('[role="option"]').map(option => option.text())
  }

  test('opens the command menu for a leading slash and filters it', async () => {
    const wrapper = mountInputBar()
    const textarea = wrapper.get('textarea')
    await textarea.setValue('/')
    expect(options(wrapper)).toHaveLength(2)
    await textarea.setValue('/auto')
    expect(options(wrapper)).toHaveLength(1)
    expect(options(wrapper)[0]).toContain('/auto-memory')
    await textarea.setValue('hello /auto')
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false)
    wrapper.unmount()
  })

  test('Enter runs the highlighted command instead of sending, and shows its result', async () => {
    const wrapper = mountInputBar()
    const textarea = wrapper.get('textarea')
    await textarea.setValue('/auto-memory')
    await textarea.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(slashRuns.autoMemory).toHaveBeenCalledOnce()
    expect(chatStore.sendMessage).not.toHaveBeenCalled()
    expect(textarea.element.value).toBe('')
    expect(wrapper.get('[role="status"]').text()).toBe('Automatic memories off')
    wrapper.unmount()
  })

  test('commands with arguments complete first, then the arrow keys pick an option', async () => {
    const wrapper = mountInputBar()
    const textarea = wrapper.get('textarea')
    await textarea.setValue('/thi')
    await textarea.trigger('keydown', { key: 'Enter' })
    expect(textarea.element.value).toBe('/think ')
    expect(options(wrapper).map(text => text.trim())).toEqual(['low', 'high'])
    await textarea.trigger('keydown', { key: 'ArrowDown' })
    expect(wrapper.findAll('[role="option"]')[1].attributes('aria-selected')).toBe('true')
    expect(textarea.attributes('aria-activedescendant')).toBe(wrapper.findAll('[role="option"]')[1].attributes('id'))
    await textarea.trigger('keydown', { key: 'Tab' })
    expect(textarea.element.value).toBe('/think high')
    await textarea.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(slashRuns.think).toHaveBeenCalledWith('high')
    wrapper.unmount()
  })

  test('a known command with an unmatched argument is not sent to the model', async () => {
    const wrapper = mountInputBar()
    const textarea = wrapper.get('textarea')
    await textarea.setValue('/think banana')
    await textarea.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(chatStore.sendMessage).not.toHaveBeenCalled()
    expect(textarea.element.value).toBe('/think banana')
    expect(wrapper.get('[role="status"]').text()).toContain('No match for “banana” in /think')
    wrapper.unmount()
  })

  test('Escape closes the menu so the text can be sent as a message', async () => {
    const wrapper = mountInputBar()
    const textarea = wrapper.get('textarea')
    await textarea.setValue('/auto-memory')
    await textarea.trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false)
    await textarea.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(slashRuns.autoMemory).not.toHaveBeenCalled()
    expect(chatStore.sendMessage).toHaveBeenCalledWith('/auto-memory', undefined, undefined, undefined, undefined)
    wrapper.unmount()
  })

  test('a command that sends a message completes, then sends the whole text', async () => {
    slashCommands.value = [{ name: 'goal', description: 'Work toward a goal', icon: 'x', group: 'Chat', hint: 'objective', sendsMessage: true }]
    const wrapper = mountInputBar()
    const textarea = wrapper.get('textarea')
    await textarea.setValue('/go')
    await textarea.trigger('keydown', { key: 'Enter' })
    expect(textarea.element.value).toBe('/goal ')
    await textarea.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(chatStore.sendMessage).not.toHaveBeenCalled()
    expect(wrapper.get('[role="status"]').text()).toBe('/goal needs an objective')
    await textarea.setValue('/goal Fix the build')
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false)
    await textarea.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(chatStore.sendMessage).toHaveBeenCalledWith('/goal Fix the build', undefined, undefined, undefined, undefined)
    wrapper.unmount()
  })

  test('an unavailable command reports why instead of running or being sent', async () => {
    const run = vi.fn()
    slashCommands.value = [{ name: 'stop', description: 'Stop', icon: 'x', group: 'Chat', unavailable: 'Nothing is running.', run }]
    const wrapper = mountInputBar()
    const textarea = wrapper.get('textarea')
    await textarea.setValue('/stop')
    expect(wrapper.get('[role="option"]').attributes('aria-disabled')).toBe('true')
    await textarea.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(run).not.toHaveBeenCalled()
    expect(chatStore.sendMessage).not.toHaveBeenCalled()
    expect(wrapper.get('[role="status"]').text()).toBe('Nothing is running.')
    wrapper.unmount()
  })

  test('a failing command shows its error', async () => {
    slashCommands.value = [{ name: 'compact', description: 'Compact', icon: 'x', group: 'Chat', run: async () => { throw new Error('Compaction failed: provider down') } }]
    const wrapper = mountInputBar()
    await wrapper.get('textarea').setValue('/compact')
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toBe('Compaction failed: provider down')
    wrapper.unmount()
  })

  test('slash paths and unknown commands are sent as ordinary messages', async () => {
    const wrapper = mountInputBar()
    const textarea = wrapper.get('textarea')
    await textarea.setValue('/etc/hosts looks wrong')
    await textarea.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(chatStore.sendMessage).toHaveBeenCalledWith('/etc/hosts looks wrong', undefined, undefined, undefined, undefined)
    wrapper.unmount()
  })
})
