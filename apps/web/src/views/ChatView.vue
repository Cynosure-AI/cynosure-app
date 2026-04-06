<script setup lang="ts">
import { ref } from 'vue'
import ChatPanel from '../components/chat/ChatPanel.vue'
import InputBar from '../components/chat/InputBar.vue'

const inputBarRef = ref<InstanceType<typeof InputBar> | null>(null)
const isDragOver = ref(false)
let dragCounter = 0

function onDragEnter(e: DragEvent): void {
  e.preventDefault()
  dragCounter++
  isDragOver.value = true
}

function onDragLeave(e: DragEvent): void {
  e.preventDefault()
  dragCounter--
  if (dragCounter <= 0) {
    dragCounter = 0
    isDragOver.value = false
  }
}

function onDragOver(e: DragEvent): void {
  e.preventDefault()
}

function onDrop(e: DragEvent): void {
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
  <div
    class="flex flex-col h-full relative"
    @dragenter="onDragEnter"
    @dragleave="onDragLeave"
    @dragover="onDragOver"
    @drop="onDrop"
  >
    <ChatPanel />
    <InputBar ref="inputBarRef" />

    <!-- Drop overlay -->
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
          Images & text files supported
        </div>
      </div>
    </div>
  </div>
</template>
