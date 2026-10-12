import { beforeEach, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { api } from '../api/client'
import { useChatStore } from './chat.store'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.spyOn(api.chat, 'subscribeLiveConversations').mockImplementation(() => {})
  vi.spyOn(api.memoryFolders, 'list').mockResolvedValue([])
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
  expect(create).toHaveBeenCalledWith(undefined, undefined, undefined, 'project-1')
  expect(store.conversations[0].projectId).toBe('project-1')

  await store.setConversationProject(null)
  expect(setProject).toHaveBeenCalledWith('new-chat', null)
  expect(store.activeProjectId).toBeNull()
  expect(store.conversations[0].projectId).toBeNull()

  await store.startNewChat()
  expect(store.activeProjectId).toBeNull()
})
