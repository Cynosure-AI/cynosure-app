import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '../api/client'
import type { AppNotification } from '../api/types'

export const useNotificationStore = defineStore('notifications', () => {
    const notifications = ref<AppNotification[]>([])
    const toasts = ref<AppNotification[]>([])
    const loaded = ref(false)
    const toastTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const toastStartedAt = new Map<string, number>()
    const toastRemaining = new Map<string, number>()
    const toastDuration = 5000

    const unreadCount = computed(() => notifications.value.filter((n) => !n.read).length)

    function sortNotifications() {
        notifications.value.sort((a, b) =>
            b.createdAt - a.createdAt
        )
    }

    async function load() {
        try {
            notifications.value = await api.notifications.list()
            sortNotifications()
            loaded.value = true
        } catch {
            notifications.value = []
        }
    }

    function addFromWs(notification: AppNotification) {
        const existingIndex = notifications.value.findIndex((n) => n.id === notification.id)
        if (existingIndex !== -1) {
            notifications.value[existingIndex] = notification
            sortNotifications()
        } else {
            notifications.value.unshift(notification)
            sortNotifications()
        }
        showToast(notification)
    }

    function showToast(notification: AppNotification) {
        dismissToast(notification.id)
        toasts.value.unshift(notification)
        toastRemaining.set(notification.id, toastDuration)
        scheduleToast(notification.id)

        while (toasts.value.length > 5) dismissToast(toasts.value[toasts.value.length - 1].id)
    }

    function scheduleToast(id: string) {
        const remaining = toastRemaining.get(id) ?? toastDuration
        toastStartedAt.set(id, Date.now())
        toastTimers.set(id, setTimeout(() => dismissToast(id), remaining))
    }

    function pauseToast(id: string) {
        const timer = toastTimers.get(id)
        const startedAt = toastStartedAt.get(id)
        if (!timer || startedAt === undefined) return
        clearTimeout(timer)
        toastTimers.delete(id)
        toastRemaining.set(id, Math.max(0, (toastRemaining.get(id) ?? toastDuration) - (Date.now() - startedAt)))
    }

    function resumeToast(id: string) {
        if (!toasts.value.some((toast) => toast.id === id) || toastTimers.has(id)) return
        scheduleToast(id)
    }

    function dismissToast(id: string) {
        const timer = toastTimers.get(id)
        if (timer) clearTimeout(timer)
        toastTimers.delete(id)
        toastStartedAt.delete(id)
        toastRemaining.delete(id)
        toasts.value = toasts.value.filter((toast) => toast.id !== id)
    }

    async function markRead(id: string) {
        await api.notifications.markRead(id)
        const n = notifications.value.find((n) => n.id === id)
        if (n) n.read = true
    }

    async function markAllRead() {
        await api.notifications.markAllRead()
        for (const n of notifications.value) {
            n.read = true
        }
    }

    async function remove(id: string) {
        await api.notifications.remove(id)
        notifications.value = notifications.value.filter((n) => n.id !== id)
        dismissToast(id)
    }

    async function removeAll() {
        await api.notifications.removeAll()
        notifications.value = []
        for (const toast of [...toasts.value]) dismissToast(toast.id)
    }

    return {
        notifications,
        toasts,
        unreadCount,
        loaded,
        load,
        addFromWs,
        dismissToast,
        pauseToast,
        resumeToast,
        markRead,
        markAllRead,
        remove,
        removeAll
    }
})
if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(useNotificationStore, import.meta.hot))
}
