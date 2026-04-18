import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '../api/client'
import type { AppNotification } from '../api/types'

export const useNotificationStore = defineStore('notifications', () => {
    const notifications = ref<AppNotification[]>([])
    const loaded = ref(false)

    const unreadCount = computed(() => notifications.value.filter((n) => !n.read).length)

    async function load() {
        try {
            notifications.value = await api.notifications.list()
            loaded.value = true
        } catch {
            notifications.value = []
        }
    }

    function addFromWs(notification: AppNotification) {
        // Avoid duplicates
        if (notifications.value.some((n) => n.id === notification.id)) return
        notifications.value.unshift(notification)
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
    }

    async function removeAll() {
        await api.notifications.removeAll()
        notifications.value = []
    }

    return {
        notifications,
        unreadCount,
        loaded,
        load,
        addFromWs,
        markRead,
        markAllRead,
        remove,
        removeAll
    }
})
if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(useNotificationStore, import.meta.hot))
}
