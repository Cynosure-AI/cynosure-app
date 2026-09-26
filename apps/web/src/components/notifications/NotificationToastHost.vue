<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { useNotificationStore } from '../../stores/notification.store'
import type { AppNotification } from '../../api/types'
import { useRouter } from 'vue-router'
import { useChatStore } from '../../stores/chat.store'

const notificationStore = useNotificationStore()
const chatStore = useChatStore()
const router = useRouter()

async function openConversation(toast: AppNotification): Promise<void> {
  if (!toast.conversationId) return
  await chatStore.selectConversation(toast.conversationId, toast.agentId || null)
  await router.push({ name: 'conversation', params: { conversationId: toast.conversationId } })
  notificationStore.dismissToast(toast.id)
  void notificationStore.markRead(toast.id)
}

function iconFor(priority: AppNotification['priority']): string {
  if (priority === 'alert') return 'lucide:triangle-alert'
  if (priority === 'action') return 'lucide:circle-alert'
  return 'lucide:info'
}
</script>

<template>
  <div
    class="pointer-events-none fixed right-4 top-4 z-[100] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
    aria-live="polite"
    aria-label="Notifications"
  >
    <TransitionGroup
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="translate-x-5 opacity-0"
      enter-to-class="translate-x-0 opacity-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="translate-x-0 opacity-100"
      leave-to-class="translate-x-5 opacity-0"
      move-class="transition-transform duration-200"
    >
      <section
        v-for="toast in notificationStore.toasts"
        :key="toast.id"
        class="pointer-events-auto overflow-hidden rounded-xl border border-theme-700 bg-theme-900/95 shadow-2xl shadow-black/30 backdrop-blur"
        role="status"
        @mouseenter="notificationStore.pauseToast(toast.id)"
        @mouseleave="notificationStore.resumeToast(toast.id)"
        @focusin="notificationStore.pauseToast(toast.id)"
        @focusout="notificationStore.resumeToast(toast.id)"
      >
        <div class="flex items-start p-3.5">
          <button
            v-if="toast.conversationId"
            type="button"
            class="-m-3.5 flex min-w-0 flex-1 items-start gap-3 rounded-lg p-3.5 text-left transition-colors hover:bg-theme-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
            :aria-label="`Open conversation: ${toast.title}`"
            @click="openConversation(toast)"
          >
            <span
              class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
              :class="toast.priority === 'alert' ? 'bg-red-500/15 text-red-400' : toast.priority === 'action' ? 'bg-amber-500/15 text-amber-400' : 'bg-accent-500/15 text-accent-400'"
            >
              <Icon
                :icon="iconFor(toast.priority)"
                class="h-4 w-4"
              />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-medium text-theme-100">{{ toast.title }}</span>
              <span class="mt-0.5 block line-clamp-3 text-xs leading-relaxed text-theme-400">{{ toast.body }}</span>
            </span>
          </button>
          <template v-else>
            <div
              class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
              :class="toast.priority === 'alert'
                ? 'bg-red-500/15 text-red-400'
                : toast.priority === 'action'
                  ? 'bg-amber-500/15 text-amber-400'
                  : 'bg-accent-500/15 text-accent-400'"
            >
              <Icon
                :icon="iconFor(toast.priority)"
                class="h-4 w-4"
              />
            </div>
            <div class="min-w-0 flex-1">
              <div class="text-sm font-medium text-theme-100">
                {{ toast.title }}
              </div>
              <p class="mt-0.5 line-clamp-3 text-xs leading-relaxed text-theme-400">
                {{ toast.body }}
              </p>
            </div>
          </template>
          <button
            type="button"
            class="-mr-1 -mt-1 ml-2 shrink-0 rounded-md p-1.5 text-theme-500 transition-colors hover:bg-theme-800 hover:text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
            :aria-label="`Dismiss ${toast.title}`"
            @click="notificationStore.dismissToast(toast.id)"
          >
            <Icon
              icon="lucide:x"
              class="h-4 w-4"
            />
          </button>
        </div>
        <div class="toast-progress h-0.5 w-full origin-left bg-accent-500/70 motion-reduce:hidden" />
      </section>
    </TransitionGroup>
  </div>
</template>

<style scoped>
@keyframes toast-life {
  from { transform: scaleX(1); }
  to { transform: scaleX(0); }
}

.toast-progress {
  animation: toast-life 5s linear forwards;
}

section:hover > div:last-child,
section:focus-within > div:last-child {
  animation-play-state: paused;
}
</style>
