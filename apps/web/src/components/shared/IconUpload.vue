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
const isProcessing = ref(false)

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024
const AVATAR_SIZE = 512

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Unable to read image'))
    reader.readAsDataURL(file)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Unable to decode image'))
    image.src = src
  })
}

async function resizeAvatar(file: File): Promise<string> {
  const image = await loadImage(await readFile(file))
  const canvas = document.createElement('canvas')
  canvas.width = AVATAR_SIZE
  canvas.height = AVATAR_SIZE
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Image processing is unavailable')

  // Fill the square without stretching. Cropping is centered, matching the
  // object-cover treatment used everywhere agent avatars are displayed.
  const scale = Math.max(AVATAR_SIZE / image.naturalWidth, AVATAR_SIZE / image.naturalHeight)
  const width = image.naturalWidth * scale
  const height = image.naturalHeight * scale
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, (AVATAR_SIZE - width) / 2, (AVATAR_SIZE - height) / 2, width, height)
  return canvas.toDataURL('image/webp', 0.9)
}

async function processFile(file: File | undefined | null) {
  errorMessage.value = null
  
  if (!file) return

  // Validate it's an image
  if (!file.type.startsWith('image/')) {
    errorMessage.value = 'Please upload a valid image file.'
    return
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    errorMessage.value = `Image is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max size is 5 MB.`
    return
  }

  isProcessing.value = true
  try {
    emit('update', await resizeAvatar(file))
  } catch {
    errorMessage.value = 'The image could not be processed. Please try another file.'
  } finally {
    isProcessing.value = false
  }
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
        Custom avatar. Images up to 5 MB are cropped and optimized to 512 × 512.
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
          :icon="isProcessing ? 'lucide:loader-2' : fallbackIcon || 'lucide:image'"
          class="w-7 h-7 transition-colors"
          :class="[isDragging ? 'text-theme-300' : 'text-theme-500', { 'animate-spin': isProcessing }]"
        />
      </div>

      <div class="flex gap-2">
        <button
          type="button"
          :disabled="isProcessing"
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
