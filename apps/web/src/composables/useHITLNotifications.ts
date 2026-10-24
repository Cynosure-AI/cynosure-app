import { watch } from 'vue'
import { useRoute } from 'vue-router'
import { useAgentStore } from '../stores/agent-runtime.store'
import { useChatStore } from '../stores/chat.store'
import { useNotificationStore } from '../stores/notification.store'

/** Notify about newly blocked chats without interrupting the conversation being viewed. */
export function useHITLNotifications(): void {
  const route = useRoute()
  const agentStore = useAgentStore()
  const chatStore = useChatStore()
  const notifications = useNotificationStore()
  const toastIds = new Set<string>()

  function isViewing(conversationId: string): boolean {
    return route.name === 'conversation' && route.params.conversationId === conversationId
  }

  watch(() => agentStore.hitlQueue, (requests, previous = []) => {
    for (const request of requests) {
      if (!request.conversationId || isViewing(request.conversationId)) continue
      if (previous.some((pending) => pending.taskId === request.taskId)) continue

      const conversation = chatStore.conversations.find((chat) => chat.id === request.conversationId)
      const id = `hitl:${request.taskId}`
      toastIds.add(id)
      notifications.showToast({
        id,
        conversationId: request.conversationId,
        agentId: conversation?.agentId ?? '',
        title: 'Approval needed',
        body: `${conversation?.title || 'A conversation'} is waiting for your approval.`,
        priority: 'action',
        createdAt: Date.now(),
        read: true,
        transient: true,
      })
    }
  }, { flush: 'sync' })

  watch(() => [agentStore.hitlQueue, route.name, route.params.conversationId], () => {
    for (const id of toastIds) {
      const pending = agentStore.hitlQueue.find((request) => `hitl:${request.taskId}` === id)
      if (!pending || (pending.conversationId && isViewing(pending.conversationId))) {
        notifications.dismissToast(id)
        toastIds.delete(id)
      }
    }
  }, { flush: 'sync' })
}
