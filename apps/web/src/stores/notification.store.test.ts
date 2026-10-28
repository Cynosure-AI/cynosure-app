import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useNotificationStore, type NotificationToast } from './notification.store'

function toast(id: string): NotificationToast {
  return {
    id,
    agentId: 'agent',
    conversationId: null,
    title: id,
    body: `${id} message`,
    priority: 'notice',
  }
}

describe('notification store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })

  test('stacks toasts newest first and dismisses them independently', () => {
    const store = useNotificationStore()

    store.showToast(toast('one'))
    store.showToast(toast('two'))
    expect(store.toasts.map(({ id }) => id)).toEqual(['two', 'one'])

    store.dismissToast('one')
    expect(store.toasts.map(({ id }) => id)).toEqual(['two'])

    vi.advanceTimersByTime(5000)
    expect(store.toasts).toEqual([])
  })

  test('replaces a toast shown again under the same id and caps the stack at five', () => {
    const store = useNotificationStore()
    store.showToast(toast('one'))
    store.showToast({ ...toast('one'), title: 'updated' })
    expect(store.toasts).toEqual([{ ...toast('one'), title: 'updated' }])

    for (const id of ['a', 'b', 'c', 'd', 'e']) store.showToast(toast(id))
    expect(store.toasts.map(({ id }) => id)).toEqual(['e', 'd', 'c', 'b', 'a'])
  })

  test('pauses toast expiry while it is being interacted with', () => {
    const store = useNotificationStore()
    store.showToast(toast('one'))

    vi.advanceTimersByTime(3000)
    store.pauseToast('one')
    vi.advanceTimersByTime(3000)
    expect(store.toasts).toHaveLength(1)

    store.resumeToast('one')
    vi.advanceTimersByTime(2000)
    expect(store.toasts).toEqual([])
  })
})
