import { beforeEach, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { api } from '../api/client'
import { useChatStore } from './chat.store'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.spyOn(api.chat, 'subscribeLiveConversations').mockImplementation(() => {})
  vi.spyOn(api.memoryFolders, 'list').mockResolvedValue([])
  vi.spyOn(api.chat, 'getPendingWait').mockResolvedValue(null)
})

test('New Chat notifies the composer and waits for draft cleanup before leaving the conversation', async () => {
  let finish!: (value: { success: boolean }) => void
  const discard = vi.spyOn(api.chat, 'discardStagedAttachments').mockReturnValue(new Promise(resolve => { finish = resolve }))
  const store = useChatStore()
  await flushPromises()
  store.activeConversationId = 'previous-chat'
  const revision = store.draftDiscardRevision
  const reset = store.startNewChat()
  expect(store.draftDiscardRevision).toBe(revision + 1)
  expect(discard).toHaveBeenCalledWith('previous-chat')
  expect(store.activeConversationId).toBe('previous-chat')
  finish({ success: true })
  await reset
  expect(store.activeConversationId).toBeNull()
})

test('New Chat clears pending composer reads even before a conversation exists', async () => {
  const discard = vi.spyOn(api.chat, 'discardStagedAttachments')
  const store = useChatStore()
  await flushPromises()
  await store.startNewChat()
  expect(store.draftDiscardRevision).toBe(1)
  expect(discard).not.toHaveBeenCalled()
})

test('a chat started in a project is created in it, and moving it updates the server', async () => {
  const create = vi.spyOn(api.chat, 'createConversation').mockResolvedValue({
    id: 'new-chat', title: 'New Chat', agentId: null, maWorkspaceId: null, projectId: 'project-1', origin: 'chat', createdAt: 1, updatedAt: 1,
  })
  const setProject = vi.spyOn(api.chat, 'setProject').mockResolvedValue({ success: true, projectId: null })
  vi.spyOn(api.chat, 'discardStagedAttachments').mockResolvedValue({ success: true })
  const store = useChatStore()
  await flushPromises()

  await store.startNewChat({ projectId: 'project-1' })
  expect(store.activeProjectId).toBe('project-1')
  await store.createConversation()
  expect(create).toHaveBeenCalledWith(undefined, undefined, undefined, 'project-1', false, undefined)
  expect(store.conversations[0].projectId).toBe('project-1')

  await store.setConversationProject(null)
  expect(setProject).toHaveBeenCalledWith('new-chat', null)
  expect(store.activeProjectId).toBeNull()
  expect(store.conversations[0].projectId).toBeNull()

  await store.startNewChat()
  expect(store.activeProjectId).toBeNull()
})

test('resetting to defaults takes the chat out of its project, before and after it is created', async () => {
  vi.spyOn(api.chat, 'createConversation').mockResolvedValue({
    id: 'new-chat', title: 'New Chat', agentId: null, maWorkspaceId: null, projectId: 'project-1', origin: 'chat', createdAt: 1, updatedAt: 1,
  })
  const setProject = vi.spyOn(api.chat, 'setProject').mockResolvedValue({ success: true, projectId: null })
  vi.spyOn(api.chat, 'discardStagedAttachments').mockResolvedValue({ success: true })
  const store = useChatStore()
  await flushPromises()

  await store.startNewChat({ projectId: 'project-1' })
  await store.resetToDefaults()
  expect(store.activeProjectId).toBeNull()
  expect(setProject).not.toHaveBeenCalled()

  await store.startNewChat({ projectId: 'project-1' })
  await store.createConversation()
  await store.resetToDefaults()
  expect(setProject).toHaveBeenCalledWith('new-chat', null)
  expect(store.activeProjectId).toBeNull()
  expect(store.conversations[0].projectId).toBeNull()
})

test('an incognito chat is created temporary and discarded when New Chat leaves it', async () => {
  const create = vi.spyOn(api.chat, 'createConversation').mockResolvedValue({
    id: 'incognito', title: 'New Chat', agentId: null, maWorkspaceId: null, projectId: null, origin: 'chat', temporary: true, createdAt: 1, updatedAt: 1,
  })
  const discard = vi.spyOn(api.chat, 'discardConversation').mockResolvedValue()
  vi.spyOn(api.chat, 'discardStagedAttachments').mockResolvedValue({ success: true })
  const store = useChatStore()
  await flushPromises()

  store.setIncognito(true)
  expect(store.activeIsTemporary).toBe(true)
  await store.createConversation()
  expect(create).toHaveBeenCalledWith(undefined, undefined, undefined, null, true, undefined)
  expect(store.activeIsTemporary).toBe(true)

  // Toggling is only for the empty new chat.
  store.setIncognito(false)
  expect(store.activeIsTemporary).toBe(true)

  await store.startNewChat()
  expect(discard).toHaveBeenCalledExactlyOnceWith('incognito')
  expect(store.conversations.some((conversation) => conversation.id === 'incognito')).toBe(false)
  expect(store.activeConversationId).toBeNull()
  expect(store.activeIsTemporary).toBe(false)
})

test('saving an incognito chat keeps it and refreshes the history', async () => {
  vi.spyOn(api.chat, 'createConversation').mockResolvedValue({
    id: 'incognito', title: 'New Chat', agentId: null, maWorkspaceId: null, projectId: null, origin: 'chat', temporary: true, createdAt: 1, updatedAt: 1,
  })
  const save = vi.spyOn(api.chat, 'saveConversation').mockResolvedValue({ success: true })
  const discard = vi.spyOn(api.chat, 'discardConversation').mockResolvedValue()
  vi.spyOn(api.chat, 'discardStagedAttachments').mockResolvedValue({ success: true })
  const store = useChatStore()
  await flushPromises()

  store.setIncognito(true)
  await store.createConversation()
  const revision = store.conversationListRevision
  await store.saveActiveConversation()
  expect(save).toHaveBeenCalledWith('incognito')
  expect(store.activeIsTemporary).toBe(false)
  expect(store.conversationListRevision).toBe(revision + 1)

  await store.startNewChat()
  expect(discard).not.toHaveBeenCalled()
})


test('restores the queue UI from a persisted wait and clears it when the wait ends', async () => {
  const wait = { jobId: 'wait-1', resumesAt: Date.now() + 300_000, note: 'Check the build' }
  vi.mocked(api.chat.getPendingWait).mockResolvedValue(wait)
  const store = useChatStore()
  store.activeConversationId = 'waiting-chat'
  await flushPromises()
  expect(store.pendingWait).toEqual(wait)
  expect(store.activeConversationHasRunningInstance).toBe(false)
  expect(store.isConversationLocked).toBe(true)

  vi.mocked(api.chat.getPendingWait).mockResolvedValue(null)
  await store.loadPendingWait()
  expect(store.isConversationLocked).toBe(false)
})

test('ignores a wait response after switching conversations', async () => {
  let resolve!: (wait: { jobId: string; resumesAt: number; note: string }) => void
  vi.mocked(api.chat.getPendingWait).mockImplementationOnce(() => new Promise(done => { resolve = done }))
  const store = useChatStore()
  store.activeConversationId = 'waiting-chat'
  store.activeConversationId = 'other-chat'
  resolve({ jobId: 'old-wait', resumesAt: Date.now() + 300_000, note: 'Old chat' })
  await flushPromises()
  expect(store.pendingWait).toBeNull()
  expect(store.isConversationLocked).toBe(false)
})
