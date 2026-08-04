<script setup lang="ts">
import ChatSidebar from '../../components/layout/ChatSidebar.vue'
import ChatHeaderBar from '../../components/chat/ChatHeaderBar.vue'
import ChatPanel from '../../components/chat/ChatPanel.vue'
import InputBar from '../../components/chat/InputBar.vue'
import PlanningTaskList from '../../components/chat/PlanningTaskList.vue'
import { computed, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useChatSidebar } from '../../composables/useSidebar'
import { useChatStore } from '../../stores/chat.store'
import { useAgentStore } from '../../stores/agent-runtime.store'

const { chatSidebarOpen, toggle } = useChatSidebar()
const chatStore = useChatStore()
const agentStore = useAgentStore()
const route = useRoute()
const router = useRouter()
const inputBarRef = ref<InstanceType<typeof InputBar> | null>(null)
const isDragOver = ref(false)
const taskListOpen = ref(false)
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

const hasPlanningTasks = computed(() => Boolean(agentStore.planningState?.items.length))

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
    />

    <!-- Main content area: sidebar + chat column -->
    <div class="flex flex-1 min-h-0 relative">
      <!-- Mobile overlay backdrop -->
      <Transition name="fade">
        <div
          v-if="chatSidebarOpen"
          class="absolute inset-0 z-30 bg-black/40 md:hidden"
          @click="toggle"
        />
      </Transition>

      <!-- Sidebar: overlay on mobile, shifts content on desktop -->
      <div
        class="absolute left-0 top-0 z-40 h-full w-64 md:relative md:z-auto md:shrink-0 md:overflow-hidden md:transition-all md:duration-200 md:ease-in-out transition-all duration-200 ease-in-out overflow-hidden"
        :class="chatSidebarOpen ? 'translate-x-0 md:w-64' : '-translate-x-full md:w-0'"
      >
        <ChatSidebar />
      </div>

      <!-- Chat column: panel + input bar -->
      <div
        class="chat-column flex flex-col flex-1 min-w-0"
        :class="{ 'chat-column--empty': showCenteredComposer }"
      >
        <!-- Chat area -->
        <div
          class="flex flex-col flex-1 min-h-0 relative"
          @dragenter="onDragEnter"
          @dragleave="onDragLeave"
          @dragover="onDragOver"
          @drop="onDrop"
        >
          <ChatPanel />

          <PlanningTaskList
            v-if="taskListOpen"
            @close="taskListOpen = false"
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

        <!-- Input bar (full width of chat column) -->
        <InputBar
          ref="inputBarRef"
          :floating="showCenteredComposer"
        />

        <div
          class="composer-spacer"
          aria-hidden="true"
        />
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

@media (prefers-reduced-motion: reduce) {
  .composer-spacer {
    transition: none;
  }
}
</style>
