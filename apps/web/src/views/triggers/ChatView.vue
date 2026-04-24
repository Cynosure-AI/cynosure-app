<script setup lang="ts">
import ChatSidebar from '../../components/layout/ChatSidebar.vue'
import ChatHeaderBar from '../../components/chat/ChatHeaderBar.vue'
import ChatPanel from '../../components/chat/ChatPanel.vue'
import InputBar from '../../components/chat/InputBar.vue'
import { ref } from 'vue'
import { useChatSidebar } from '../../composables/useSidebar'

const { chatSidebarOpen, toggle } = useChatSidebar()
const inputBarRef = ref<InstanceType<typeof InputBar> | null>(null)
const isDragOver = ref(false)
let dragCounter = 0

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
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden">
    <!-- Header bar -->
    <ChatHeaderBar />

    <!-- Content: sidebar overlay + chat -->
    <div class="flex flex-1 min-h-0 relative">
      <!-- Overlay backdrop -->
      <Transition name="fade">
        <div
          v-if="chatSidebarOpen"
          class="absolute inset-0 z-30 bg-black/40 md:hidden"
          @click="toggle"
        />
      </Transition>

      <!-- Collapsible sidebar (overlay) -->
      <Transition name="slide">
        <div
          v-if="chatSidebarOpen"
          class="absolute left-0 top-0 z-40 h-full w-64"
        >
          <ChatSidebar />
        </div>
      </Transition>

      <!-- Chat area -->
      <div
        class="flex flex-col flex-1 min-w-0 relative"
        @dragenter="onDragEnter"
        @dragleave="onDragLeave"
        @dragover="onDragOver"
        @drop="onDrop"
      >
        <ChatPanel />

        <div
          v-if="isDragOver"
          class="absolute inset-0 z-50 flex items-center justify-center bg-zinc-900/80 border-2 border-dashed border-blue-500 rounded-lg pointer-events-none"
        >
          <div class="text-center">
            <div class="text-4xl mb-2">
              📎
            </div>
            <div class="text-blue-400 text-sm font-medium">
              Drop files here
            </div>
            <div class="text-zinc-500 text-xs mt-1">
              Images &amp; text files supported
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Input bar (full width) -->
    <InputBar ref="inputBarRef" />
  </div>
</template>

<style scoped>
/* Sidebar slide */
.slide-enter-active,
.slide-leave-active {
  transition: transform 0.2s ease;
}
.slide-enter-from,
.slide-leave-to {
  transform: translateX(-100%);
}

/* Backdrop fade */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
