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
