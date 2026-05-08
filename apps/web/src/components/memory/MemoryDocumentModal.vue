<script setup lang="ts">
import { computed } from 'vue'
import { Icon } from '@iconify/vue'

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
      <div class="bg-zinc-900 border border-zinc-700 rounded-xl shadow-xl w-full max-w-3xl mx-4 max-h-[85vh] flex flex-col">
        <!-- Header -->
        <div class="flex items-center justify-between px-5 py-4 border-b border-zinc-800 shrink-0">
          <div class="flex items-center gap-3 min-w-0">
            <Icon
              icon="lucide:file-text"
              class="w-5 h-5 text-zinc-400 shrink-0"
            />
            <div class="min-w-0">
              <h3 class="text-sm font-medium text-zinc-200 truncate">
                {{ sourceFile }}
              </h3>
              <p class="text-xs text-zinc-500">
                {{ chunkCount }} chunks
              </p>
            </div>
          </div>
          <button
            class="p-1.5 text-zinc-500 hover:text-zinc-300 rounded-lg hover:bg-zinc-800 transition-colors"
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
            class="flex items-center justify-center gap-2 py-12 text-zinc-500 text-xs"
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
                class="relative px-5 py-4"
                :class="index > 0 ? 'border-t border-zinc-800/60' : ''"
              >
                <span class="absolute left-5 top-0 -translate-y-1/2 bg-zinc-900 px-1 text-[9px] font-mono text-zinc-500 tracking-wide uppercase">
                  Chunk #{{ (chunk.chunkIndex ?? 0) + 1 }}
                </span>
                <pre class="text-xs text-zinc-400 whitespace-pre-wrap font-mono leading-relaxed">{{ chunk.text }}</pre>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>
