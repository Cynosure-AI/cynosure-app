<script setup lang="ts">
import { computed } from 'vue'
import { Icon } from '@iconify/vue'
import { renderMarkdown, handleMarkdownClick } from '../../utils/markdown'

interface MemoryEntry {
  id: string
  text: string
  source: string
  tags?: string
  sourceFile?: string
  chunkIndex?: number
  createdAt: number
}

const props = defineProps<{
  show: boolean
  spaceId: string
  sourceFile: string
  chunkCount: number
  chunks: MemoryEntry[]
  loading: boolean
}>()

defineEmits<{
  close: []
}>()

const sortedChunks = computed(() =>
  [...props.chunks].sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0))
)

</script>

<template>
  <Teleport to="body">
    <div
      v-if="show && sourceFile"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      @click.self="$emit('close')"
    >
      <div class="bg-theme-900 border border-theme-700 rounded-xl shadow-xl w-full max-w-3xl mx-4 max-h-[85vh] flex flex-col">
        <!-- Header -->
        <div class="flex items-center justify-between px-5 py-4 border-b border-theme-800 shrink-0">
          <div class="flex items-center gap-3 min-w-0">
            <Icon
              icon="lucide:file-text"
              class="w-5 h-5 text-theme-400 shrink-0"
            />
            <div class="min-w-0">
              <h3 class="text-sm font-medium text-theme-200 truncate">
                {{ sourceFile }}
              </h3>
              <p class="text-xs text-theme-500">
                {{ chunkCount }} chunks
              </p>
            </div>
          </div>
          <button
            class="p-1.5 text-theme-500 hover:text-theme-300 rounded-lg hover:bg-theme-800 transition-colors"
            @click="$emit('close')"
          >
            <Icon
              icon="lucide:x"
              class="w-4 h-4"
            />
          </button>
        </div>

        <!-- Content -->
        <div class="flex-1 overflow-y-auto">
          <div
            v-if="loading"
            class="flex items-center justify-center gap-2 py-12 text-theme-500 text-xs"
          >
            <Icon
              icon="lucide:loader-2"
              class="w-4 h-4 animate-spin"
            />
            Loading…
          </div>

          <template v-else-if="chunks.length > 0">
            <div class="pt-4">
              <div
                v-for="(chunk, index) in sortedChunks"
                :key="chunk.id"
                class="relative px-5 py-4 group"
                :class="index > 0 ? 'border-t border-theme-800/60' : ''"
              >
                <div class="flex items-center justify-between mb-1">
                  <span class="text-[9px] font-mono text-theme-500 tracking-wide uppercase">
                    Chunk #{{ (chunk.chunkIndex ?? 0) + 1 }}
                  </span>
                </div>

                <div
                  class="msg-markdown prose dark:prose-invert prose-sm max-w-none text-theme-300"
                  @click="handleMarkdownClick"
                  v-html="renderMarkdown(chunk.text)"
                />
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>
