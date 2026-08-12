<script setup lang="ts">
import { computed } from 'vue'
import { Icon } from '@iconify/vue'

const props = defineProps<{
  src: string | null
}>()

const emit = defineEmits<{
  close: []
}>()

const downloadName = computed(() => {
  if (!props.src) return 'artifact-image'

  try {
    const url = new URL(props.src, window.location.origin)
    const filePath = url.searchParams.get('path') || url.pathname
    const filename = decodeURIComponent(filePath).split('/').pop()
    if (filename) return filename
  } catch {
    // Data and blob URLs use the fallback name below.
  }

  const mimeType = props.src.match(/^data:image\/([^;,]+)/i)?.[1]?.toLowerCase()
  const extension = mimeType === 'jpeg' ? 'jpg' : mimeType
  return extension ? `artifact-image.${extension}` : 'artifact-image'
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="src"
      class="fixed inset-0 z-100 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      role="dialog"
      aria-label="Full-size image preview"
      aria-modal="true"
      tabindex="0"
      @click.self="emit('close')"
      @keydown.escape="emit('close')"
    >
      <div class="absolute top-4 right-4 z-10 flex items-center gap-2">
        <a
          :href="src"
          :download="downloadName"
          class="inline-flex items-center gap-2 rounded-full bg-theme-800/80 px-3 py-2 text-sm text-theme-300 transition-colors hover:bg-theme-700 hover:text-white"
          title="Download image"
          aria-label="Download image"
          @click.stop
        >
          <Icon
            icon="lucide:download"
            class="h-5 w-5"
          />
          <span class="hidden sm:inline">Download</span>
        </a>
        <button
          class="rounded-full bg-theme-800/80 p-2 text-theme-300 transition-colors hover:bg-theme-700 hover:text-white"
          title="Close"
          aria-label="Close image preview"
          @click="emit('close')"
        >
          <Icon
            icon="mdi:close"
            class="h-5 w-5"
          />
        </button>
      </div>
      <img
        :src="src"
        alt="Full-size artifact"
        class="max-h-[90vh] max-w-[90vw] rounded-xl object-contain shadow-2xl"
        @click.stop
      >
    </div>
  </Teleport>
</template>
