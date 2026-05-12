<script setup lang="ts">
import { ref } from 'vue'
import { Icon } from '@iconify/vue'

defineProps<{
  iconUrl: string | null
  fallbackIcon?: string
}>()

const emit = defineEmits<{
  update: [value: string | null]
}>()

const fileInput = ref<HTMLInputElement | null>(null)
const isDragging = ref(false)
const errorMessage = ref<string | null>(null)

function processFile(file: File | undefined | null) {
  errorMessage.value = null
  
  if (!file) return

  // Validate it's an image
  if (!file.type.startsWith('image/')) {
    errorMessage.value = 'Please upload a valid image file.'
    return
  }

  // Validate size (2 MB max)
  if (file.size > 2 * 1024 * 1024) {
    errorMessage.value = `Image is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max size is 2 MB.`
    return
  }

  const reader = new FileReader()
  reader.onload = () => {
    emit('update', reader.result as string)
  }
  reader.onerror = () => {
    errorMessage.value = 'An error occurred while reading the file.'
  }
  reader.readAsDataURL(file)
}

function handleUpload(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  processFile(file)
  
  // Reset input so the same file can be uploaded again if removed
  if (fileInput.value) {
    fileInput.value.value = ''
  }
}

function handleDrop(event: DragEvent) {
  isDragging.value = false
  event.stopPropagation()
  // Clear the file input so a stale cached selection can't race against the drop
  if (fileInput.value) fileInput.value.value = ''
  const file = event.dataTransfer?.files?.[0]
  processFile(file)
}

function removeImage() {
  emit('update', null)
  errorMessage.value = null
}
</script>

<template>
  <div>
    <label class="block text-sm text-theme-400 mb-1.5">Icon</label>
    <p class="text-xs text-theme-600 mb-2">
      <slot name="description">
        Custom avatar. Falls back to the default icon if not set.
      </slot>
    </p>
    
    <div class="flex items-center gap-4">
      <div
        class="relative w-14 h-14 rounded-xl border flex items-center justify-center overflow-hidden cursor-pointer transition-colors"
        :class="[
          isDragging 
            ? 'bg-theme-700 border-theme-400 ring-2 ring-theme-500'
            : 'bg-theme-800 border-theme-700 hover:border-theme-500'
        ]"
        @click="fileInput?.click()"
        @dragover.prevent="isDragging = true"
        @dragleave.prevent="isDragging = false"
        @drop.prevent="handleDrop"
      >
        <img
          v-if="iconUrl"
          :src="iconUrl"
          alt="Icon"
          class="w-full h-full object-cover transition-opacity"
          :class="{ 'opacity-50': isDragging }"
        >
        <Icon
          v-else
          :icon="fallbackIcon || 'lucide:image'"
          class="w-7 h-7 transition-colors"
          :class="isDragging ? 'text-theme-300' : 'text-theme-500'"
        />
      </div>

      <div class="flex gap-2">
        <button
          type="button"
          class="px-3 py-1.5 bg-theme-700 hover:bg-theme-600 text-theme-300 text-xs rounded-lg transition-colors"
          @click="fileInput?.click()"
        >
          Upload
        </button>
        <button
          v-if="iconUrl"
          type="button"
          class="px-3 py-1.5 bg-theme-800 hover:bg-theme-700 text-theme-400 text-xs rounded-lg transition-colors"
          @click="removeImage"
        >
          Remove
        </button>
      </div>

      <input
        ref="fileInput"
        type="file"
        accept="image/*"
        class="hidden"
        @change="handleUpload"
      >
    </div>

    <p
      v-if="errorMessage"
      class="text-xs text-red-500 mt-2 font-medium"
    >
      {{ errorMessage }}
    </p>
  </div>
</template>
