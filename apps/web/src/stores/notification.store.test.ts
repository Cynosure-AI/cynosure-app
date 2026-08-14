import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AppNotification } from '../api/types'

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  markRead: vi.fn(),
  markAllRead: vi.fn(),
  remove: vi.fn(),
  removeAll: vi.fn(),
}))

vi.mock('../api/client', () => ({
  api: { notifications: apiMocks },
}))

import { useNotificationStore } from './notification.store'

function notification(id: string, createdAt: number, read = false): AppNotification {
  return {
    id,
    agentId: 'agent',
    conversationId: null,
    createdAt,
    read,
    title: id,
    body: `${id} message`,
    priority: 'notice',
  }
}

describe('notification store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  test('loads notifications newest first and computes unread count', async () => {
    apiMocks.list.mockResolvedValue([
      notification('old', 1, false),
      notification('new', 3, true),
      notification('middle', 2, false),
    ])
    const store = useNotificationStore()

    await store.load()

    expect(store.notifications.map(({ id }) => id)).toEqual(['new', 'middle', 'old'])
    expect(store.unreadCount).toBe(2)
    expect(store.loaded).toBe(true)
  })

  test('clears stale data but does not claim a failed load completed', async () => {
    apiMocks.list.mockRejectedValue(new Error('offline'))
    const store = useNotificationStore()
    store.notifications = [notification('stale', 1)]

    await store.load()

    expect(store.notifications).toEqual([])
    expect(store.loaded).toBe(false)
  })

  test('merges websocket updates by id and keeps chronological order', () => {
    const store = useNotificationStore()
    store.addFromWs(notification('one', 1))
    store.addFromWs(notification('two', 2))
    store.addFromWs(notification('one', 3, true))

    expect(store.notifications.map(({ id }) => id)).toEqual(['one', 'two'])
    expect(store.notifications[0].read).toBe(true)
    expect(store.unreadCount).toBe(1)
  })

  test('updates local state only after mutation requests succeed', async () => {
    apiMocks.markRead.mockResolvedValue(undefined)
    apiMocks.markAllRead.mockResolvedValue(undefined)
    apiMocks.remove.mockResolvedValue(undefined)
    apiMocks.removeAll.mockResolvedValue(undefined)
    const store = useNotificationStore()
    store.notifications = [notification('one', 1), notification('two', 2)]

    await store.markRead('one')
    expect(store.notifications.find(({ id }) => id === 'one')?.read).toBe(true)
    await store.markAllRead()
    expect(store.unreadCount).toBe(0)
    await store.remove('one')
    expect(store.notifications.map(({ id }) => id)).toEqual(['two'])
    await store.removeAll()
    expect(store.notifications).toEqual([])
  })
})
