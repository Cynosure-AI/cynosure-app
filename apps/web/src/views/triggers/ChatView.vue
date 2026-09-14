<script setup lang="ts">
import ChatHeaderBar from '../../components/chat/ChatHeaderBar.vue'
import ChatPanel from '../../components/chat/ChatPanel.vue'
import InputBar from '../../components/chat/InputBar.vue'
import PlanningTaskList from '../../components/chat/PlanningTaskList.vue'
import { computed, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useChatStore, type Conversation } from '../../stores/chat.store'
import { useAgentStore } from '../../stores/agent-runtime.store'
import { useProviderStore } from '../../stores/provider.store'
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

const showCenteredComposer = computed(() => {
  const routeConversationId = Array.isArray(route.params.conversationId)
    ? route.params.conversationId[0]
    : route.params.conversationId

  return !routeConversationId &&
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
const hasProviders = computed(() => providerStore.providers.length > 0)

function openProviderSettings(): void {
  router.push({ name: 'settings', query: { category: 'providers' } })
}

watch(
  () => agentStore.planningState?.runId,
  (runId) => {
    taskListOpen.value = Boolean(runId)
  },
  { immediate: true }
)

function onDragEnter(e: DragEvent) {
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

async function openRecentChat(conversation: Conversation): Promise<void> {
  await chatStore.selectConversation(conversation.id, conversation.agentId ?? null)
  await router.push({ name: 'conversation', params: { conversationId: conversation.id } })
}

onUnmounted(() => {
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

    <main
      v-if="!hasProviders"
      class="flex flex-1 min-h-0 items-center justify-center overflow-auto p-4 sm:p-6"
    >
      <section
        class="provider-empty-state w-full max-w-5xl"
        aria-labelledby="provider-empty-title"
      >
        <div
          class="provider-empty-orbit provider-empty-orbit--top"
          aria-hidden="true"
        />
        <div
          class="provider-empty-orbit provider-empty-orbit--bottom"
          aria-hidden="true"
        />
        <div
          class="provider-empty-dots provider-empty-dots--top"
          aria-hidden="true"
        />
        <div
          class="provider-empty-dots provider-empty-dots--bottom"
          aria-hidden="true"
        />

        <div class="relative z-10 mx-auto flex max-w-3xl flex-col items-center">
          <div class="provider-empty-icon-wrap mb-5">
            <span class="provider-empty-icon-ring provider-empty-icon-ring--outer" />
            <span class="provider-empty-icon-ring provider-empty-icon-ring--inner" />
            <span class="provider-empty-spark provider-empty-spark--left">+</span>
            <span class="provider-empty-spark provider-empty-spark--right">+</span>
            <div class="provider-empty-icon">
              <Icon
                icon="lucide:cpu"
                class="h-9 w-9"
              />
            </div>
          </div>

          <h2
            id="provider-empty-title"
            class="text-center text-2xl font-semibold tracking-tight text-theme-100 sm:text-3xl"
          >
            No <span class="text-accent-400">Provider</span> Set Up
          </h2>
          <p class="mt-2 max-w-2xl text-center text-sm leading-6 text-theme-400 sm:text-base">
            Connect an AI provider before starting a conversation. It supplies the model that powers your chats and agents.
          </p>

          <button
            type="button"
            class="provider-empty-cta mt-8 inline-flex items-center gap-2 rounded-xl bg-accent-600 px-5 py-3 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-accent-500 sm:px-6 sm:text-base"
            @click="openProviderSettings"
          >
            <Icon
              icon="lucide:plus"
              class="h-5 w-5"
            />
            Set Up a Provider
          </button>
          <p class="mt-3 text-center text-xs text-theme-500 sm:text-sm">
            Add an API provider or connect a locally hosted model.
          </p>
        </div>
      </section>
    </main>

    <!-- Main content area -->
    <div
      v-else
      class="flex flex-1 min-h-0 relative"
    >
      <!-- Chat column: panel + input bar -->
      <div
        class="chat-column relative flex flex-col flex-1 min-w-0"
        :class="{ 'chat-column--empty': showCenteredComposer }"
        @dragenter="onDragEnter"
        @dragleave="onDragLeave"
        @dragover="onDragOver"
        @drop="onDrop"
      >
        <!-- Chat area -->
        <div class="flex flex-col flex-1 min-h-0 relative">
          <ChatPanel
            :search-open="chatSearchOpen"
            @close-search="chatSearchOpen = false"
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

.provider-empty-state {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  min-height: 30rem;
  padding: 4rem 2rem;
  border: 1px solid color-mix(in srgb, var(--color-theme-600) 42%, transparent);
  border-radius: 1rem;
  background:
    radial-gradient(circle at 7% 5%, color-mix(in srgb, var(--color-accent-600) 14%, transparent), transparent 18rem),
    radial-gradient(circle at 96% 92%, color-mix(in srgb, var(--color-accent-600) 13%, transparent), transparent 20rem),
    linear-gradient(145deg, color-mix(in srgb, var(--color-theme-800) 78%, transparent), color-mix(in srgb, var(--color-theme-900) 92%, transparent));
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--color-theme-100) 5%, transparent);
}

.provider-empty-state::before {
  position: absolute;
  inset: 0;
  z-index: -1;
  background-image: repeating-linear-gradient(135deg, transparent 0 10px, color-mix(in srgb, var(--color-theme-100) 2%, transparent) 10px 11px);
  mask-image: linear-gradient(to bottom, transparent 35%, #000 100%);
  content: '';
}

.provider-empty-orbit {
  position: absolute;
  width: 20rem;
  height: 20rem;
  border: 1px solid color-mix(in srgb, var(--color-accent-500) 35%, transparent);
  border-radius: 9999px;
  pointer-events: none;
}

.provider-empty-orbit::after {
  position: absolute;
  inset: 4.25rem;
  border: 1px solid color-mix(in srgb, var(--color-theme-300) 12%, transparent);
  border-radius: inherit;
  content: '';
}

.provider-empty-orbit--top { top: -12.5rem; left: -7rem; }
.provider-empty-orbit--bottom { right: -7.5rem; bottom: -13.5rem; }

.provider-empty-dots {
  position: absolute;
  width: 9rem;
  height: 5rem;
  opacity: .48;
  background-image: radial-gradient(circle, var(--color-accent-400) 1px, transparent 1.5px);
  background-size: 18px 18px;
  pointer-events: none;
}

.provider-empty-dots--top { top: 2rem; right: 2rem; mask-image: linear-gradient(135deg, transparent, #000); }
.provider-empty-dots--bottom { bottom: 2rem; left: 2rem; mask-image: linear-gradient(315deg, transparent, #000); }

.provider-empty-icon-wrap {
  position: relative;
  display: grid;
  width: 7.5rem;
  height: 7.5rem;
  place-items: center;
}

.provider-empty-icon-ring {
  position: absolute;
  border: 1px solid color-mix(in srgb, var(--color-accent-500) 33%, transparent);
  border-radius: 9999px;
}

.provider-empty-icon-ring--outer { inset: 0; box-shadow: inset 0 0 28px color-mix(in srgb, var(--color-accent-500) 5%, transparent); }
.provider-empty-icon-ring--inner { inset: .55rem; border-color: color-mix(in srgb, var(--color-accent-400) 24%, transparent); }

.provider-empty-icon {
  display: grid;
  width: 4.25rem;
  height: 4.25rem;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--color-accent-400) 40%, transparent);
  border-radius: 1.25rem;
  background: radial-gradient(circle at 35% 25%, color-mix(in srgb, var(--color-accent-400) 24%, transparent), color-mix(in srgb, var(--color-theme-900) 93%, transparent));
  color: var(--color-accent-300);
  box-shadow: 0 0 30px color-mix(in srgb, var(--color-accent-500) 20%, transparent), inset 0 1px 0 color-mix(in srgb, var(--color-theme-100) 12%, transparent);
}

.provider-empty-spark {
  position: absolute;
  color: var(--color-accent-400);
  font-size: 1.25rem;
  font-weight: 300;
  line-height: 1;
  text-shadow: 0 0 12px var(--color-accent-500);
}

.provider-empty-spark--left { top: 62%; left: -.1rem; }
.provider-empty-spark--right { top: 20%; right: -.15rem; }

.provider-empty-cta {
  color: var(--accent-button-foreground);
  box-shadow: 0 10px 28px color-mix(in srgb, var(--color-accent-600) 28%, transparent), inset 0 1px 0 color-mix(in srgb, #fff 20%, transparent);
}

@media (max-width: 767px) {
  .provider-empty-state {
    min-height: auto;
    padding: 2.5rem 1rem;
  }

  .provider-empty-orbit,
  .provider-empty-dots {
    opacity: .45;
  }
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
