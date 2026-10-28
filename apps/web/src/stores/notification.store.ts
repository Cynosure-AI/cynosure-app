import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref } from 'vue'

/** A temporary in-app toast, e.g. for a chat waiting on approval. Toasts are not stored. */
export interface NotificationToast {
    id: string
    agentId: string
    conversationId: string | null
    title: string
    body: string
    priority: 'notice' | 'action' | 'alert'
}

export const useNotificationStore = defineStore('notifications', () => {
    const toasts = ref<NotificationToast[]>([])
    const toastTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const toastStartedAt = new Map<string, number>()
    const toastRemaining = new Map<string, number>()
    const toastDuration = 5000

    function showToast(notification: NotificationToast, duration = toastDuration) {
        dismissToast(notification.id)
        toasts.value.unshift(notification)
        toastRemaining.set(notification.id, duration)
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

    return {
        toasts,
        showToast,
        dismissToast,
        pauseToast,
        resumeToast
    }
})
if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(useNotificationStore, import.meta.hot))
}
