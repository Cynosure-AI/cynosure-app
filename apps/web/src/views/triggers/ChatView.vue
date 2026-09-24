<script setup lang="ts">
import ChatHeaderBar from '../../components/chat/ChatHeaderBar.vue'
import ChatPanel from '../../components/chat/ChatPanel.vue'
import InputBar from '../../components/chat/InputBar.vue'
import PlanningTaskList from '../../components/chat/PlanningTaskList.vue'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useChatStore, type Conversation } from '../../stores/chat.store'
import { useAgentStore } from '../../stores/agent-runtime.store'
import { useProviderStore } from '../../stores/provider.store'
import { wsConnected } from '../../api/http'
import { Icon } from '@iconify/vue'

const chatStore = useChatStore()
const agentStore = useAgentStore()
const providerStore = useProviderStore()
const route = useRoute()
const router = useRouter()
const inputBarRef = ref<InstanceType<typeof InputBar> | null>(null)
const isDragOver = ref(false)
const taskListOpen = ref(false)
const chatSearchOpen = ref(false)
let dragCounter = 0
let syncingFromRoute = false
const canUseChat = computed(() => providerStore.providersLoaded && providerStore.providers.length > 0)
const hasNoProviders = computed(() => providerStore.providersLoaded && providerStore.providers.length === 0)

const showCenteredComposer = computed(() => {
  const routeConversationId = Array.isArray(route.params.conversationId)
    ? route.params.conversationId[0]
    : route.params.conversationId

  return canUseChat.value &&
    !routeConversationId &&
    !chatStore.activeConversationId &&
    !chatStore.loadingMessages &&
    chatStore.messages.length === 0
})

const latestAgentChats = computed(() => {
  const agentId = chatStore.activeAgentId
  if (!agentId) return []

  return [...chatStore.conversations]
    .filter(conversation => conversation.agentId === agentId && conversation.origin === 'chat')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 4)
})

const hasPlanningTasks = computed(() => Boolean(agentStore.planningState?.items.length))
const hasSearchableMessages = computed(() => chatStore.messages.some(message =>
  message.role !== 'system'
  && message.role !== 'tool'
  && message.content.trim().length > 0
))

function onChatSearchShortcut(event: KeyboardEvent): void {
  if (
    event.key.toLocaleLowerCase() !== 'f'
    || (!event.ctrlKey && !event.metaKey)
    || event.altKey
    || event.shiftKey
    || !hasSearchableMessages.value
  ) return

  event.preventDefault()
  chatSearchOpen.value = true
}

onMounted(() => {
  document.addEventListener('keydown', onChatSearchShortcut)
})

watch(
  () => agentStore.planningState?.runId,
  (runId) => {
    taskListOpen.value = Boolean(runId)
  },
  { immediate: true }
)

function onDragEnter(e: DragEvent) {
  if (!canUseChat.value) return
  e.preventDefault()
  dragCounter++
  isDragOver.value = true
}

function onDragLeave(e: DragEvent) {
  e.preventDefault()
  dragCounter--
  if (dragCounter <= 0) {
    dragCounter = 0
    isDragOver.value = false
  }
}

function onDragOver(e: DragEvent) {
  e.preventDefault()
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  dragCounter = 0
  isDragOver.value = false
  const files = e.dataTransfer?.files
  if (files?.length && inputBarRef.value) {
    inputBarRef.value.processFiles(Array.from(files))
  }
}

function sendQuickResponse(suggestion: string): void {
  void inputBarRef.value?.sendSuggestion(suggestion)
}

async function openRecentChat(conversation: Conversation): Promise<void> {
  await chatStore.selectConversation(conversation.id, conversation.agentId ?? null)
  await router.push({ name: 'conversation', params: { conversationId: conversation.id } })
}

onUnmounted(() => {
  document.removeEventListener('keydown', onChatSearchShortcut)
  const conversationId = chatStore.activeConversationId
  if (conversationId) chatStore.markConversationRead(conversationId)
})

watch(
  () => route.params.conversationId,
  async (param) => {
    const conversationId = Array.isArray(param) ? param[0] : param
    if (!conversationId || chatStore.activeConversationId === conversationId) return
    syncingFromRoute = true
    try {
      await chatStore.selectConversation(conversationId)
    } catch (error) {
      console.error('[chat] Failed to open conversation from route:', error)
      router.replace({ name: 'triggers-chat' })
    } finally {
      syncingFromRoute = false
    }
  },
  { immediate: true }
)

watch(
  () => chatStore.activeConversationId,
  () => {
    chatSearchOpen.value = false
  }
)

watch(
  [() => chatStore.activeConversationId, () => route.name],
  ([conversationId]) => {
    if (syncingFromRoute || (route.name !== 'triggers-chat' && route.name !== 'conversation')) return
    const routeConversationId = typeof route.params.conversationId === 'string' ? route.params.conversationId : null
    if (conversationId && routeConversationId !== conversationId) {
      router.replace({ name: 'conversation', params: { conversationId } })
    } else if (!conversationId && route.name === 'conversation') {
      router.replace({ name: 'triggers-chat' })
    }
  }
)
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden">
    <!-- Header bar (full width) -->
    <ChatHeaderBar
      :has-planning-tasks="hasPlanningTasks"
      :task-list-open="taskListOpen"
      :planning-task-count="agentStore.planningState?.items.length ?? 0"
      @toggle-task-list="taskListOpen = !taskListOpen"
      @search-chat="chatSearchOpen = true"
    />

    <!-- Main content area -->
    <div class="flex flex-1 min-h-0 relative">
      <!-- Chat column: panel + input bar -->
      <div
        class="chat-column relative flex flex-col flex-1 min-w-0"
        :class="{ 'chat-column--empty': showCenteredComposer }"
        @dragenter="onDragEnter"
        @dragleave="onDragLeave"
        @dragover="onDragOver"
        @drop="onDrop"
      >
        <div
          v-if="!wsConnected"
          class="flex flex-1 min-h-0 flex-col"
          data-testid="chat-initialising"
        >
          <ChatPanel />
        </div>

        <div
          v-else-if="!providerStore.providersLoaded"
          class="flex flex-1 items-center justify-center text-theme-500"
          aria-label="Loading AI providers"
        >
          <Icon
            icon="lucide:loader-2"
            class="h-6 w-6 animate-spin"
          />
        </div>

        <div
          v-else-if="hasNoProviders"
          class="flex flex-1 items-center justify-center px-6 py-12"
          data-testid="chat-no-providers"
        >
          <div class="max-w-md text-center">
            <div class="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent-500/10">
              <Icon
                icon="lucide:brain-circuit"
                class="h-8 w-8 text-accent-400"
              />
            </div>
            <h2 class="mb-2 text-xl font-medium text-theme-100">
              Set up an AI provider to start chatting
            </h2>
            <p class="mb-6 text-sm leading-relaxed text-theme-500">
              Chat needs an AI provider and model. Add one in Settings, then return here to begin a conversation.
            </p>
            <button
              type="button"
              class="inline-flex items-center gap-2 rounded-lg bg-accent-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-500"
              @click="router.push({ name: 'settings', query: { category: 'providers' } })"
            >
              <Icon
                icon="lucide:settings"
                class="h-4 w-4"
              />
              Configure providers
            </button>
          </div>
        </div>

        <template v-else>
          <!-- Chat area -->
          <div class="flex flex-col flex-1 min-h-0 relative">
            <ChatPanel
              :search-open="chatSearchOpen"
              @close-search="chatSearchOpen = false"
              @select-quick-response="sendQuickResponse"
            />

            <PlanningTaskList
              v-if="taskListOpen"
              @close="taskListOpen = false"
            />
          </div>

          <!-- Input bar (full width of chat column) -->
          <InputBar
            ref="inputBarRef"
            :floating="showCenteredComposer"
          />

          <div
            v-if="showCenteredComposer && latestAgentChats.length"
            class="recent-agent-chats mx-auto flex w-full max-w-5xl flex-wrap justify-center gap-2 px-4 pb-3"
            aria-label="Recent chats with this agent"
          >
            <button
              v-for="(conversation, index) in latestAgentChats"
              :key="conversation.id"
              type="button"
              class="recent-agent-chat-pill inline-flex max-w-full items-center gap-1.5 rounded-full border border-theme-700/80 bg-theme-800/70 px-3 py-1.5 text-xs text-theme-400 shadow-sm transition-colors hover:border-accent-500/50 hover:bg-theme-800 hover:text-theme-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/70"
              :style="{ animationDelay: `${120 + index * 80}ms` }"
              :title="conversation.title"
              @click="openRecentChat(conversation)"
            >
              <Icon
                icon="lucide:history"
                class="h-3.5 w-3.5 shrink-0 text-theme-500"
              />
              <span class="max-w-52 truncate">{{ conversation.title }}</span>
            </button>
          </div>

          <div
            class="composer-spacer hidden md:block"
            aria-hidden="true"
          />
        </template>

        <div
          v-if="isDragOver"
          class="absolute inset-0 z-50 flex items-center justify-center bg-theme-900/80 border-2 border-dashed border-accent-500 rounded-lg pointer-events-none"
        >
          <div class="text-center">
            <div class="text-4xl mb-2">
              📎
            </div>
            <div class="text-accent-400 text-sm font-medium">
              Drop files here
            </div>
            <div class="text-theme-500 text-xs mt-1">
              Images &amp; text files supported
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Backdrop fade */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.chat-column > :deep(.chat-input-bar) {
  flex: 0 0 auto;
}

.composer-spacer {
  flex: 0 0 0;
  min-height: 0;
  transition: flex-grow 520ms cubic-bezier(0.22, 1, 0.36, 1);
}

.chat-column--empty .composer-spacer {
  flex-grow: 1;
}

.chat-column--empty > div:first-child {
  flex-grow: 1;
  flex-basis: 0;
}

.recent-agent-chat-pill {
  opacity: 0;
  animation: recent-chat-pill-in 420ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
}

@keyframes recent-chat-pill-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .composer-spacer {
    transition: none;
  }

  .recent-agent-chat-pill {
    opacity: 1;
    animation: none;
  }
}
</style>
