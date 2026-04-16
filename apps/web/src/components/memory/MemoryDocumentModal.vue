<script setup lang="ts">
import { ref, computed } from 'vue'
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

const viewMode = ref<'merged' | 'chunks'>('merged')

const sortedChunks = computed(() =>
  [...props.chunks].sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0))
)

function findOverlap(a: string, b: string): number {
  const maxLen = Math.min(a.length, b.length, 300)
  for (let len = maxLen; len > 0; len--) {
    if (a.endsWith(b.slice(0, len))) return len
  }
  return 0
}

const mergedText = computed(() => {
  const ordered = sortedChunks.value
  if (ordered.length === 0) return ''
  let result = ordered[0].text
  for (let i = 1; i < ordered.length; i++) {
    const overlap = findOverlap(result, ordered[i].text)
    result += ordered[i].text.slice(overlap)
  }
  return result
})
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

        <!-- View mode toggle -->
        <div class="flex items-center gap-1 px-5 py-2.5 border-b border-zinc-800/60 shrink-0">
          <button
            class="px-3 py-1.5 text-xs rounded-md transition-colors"
            :class="viewMode === 'merged'
              ? 'bg-zinc-700 text-zinc-200'
              : 'text-zinc-500 hover:text-zinc-300'"
            @click="viewMode = 'merged'"
          >
            <Icon
              icon="lucide:file-text"
              class="w-3 h-3 inline mr-1"
            />
            Document
          </button>
          <button
            class="px-3 py-1.5 text-xs rounded-md transition-colors"
            :class="viewMode === 'chunks'
              ? 'bg-zinc-700 text-zinc-200'
              : 'text-zinc-500 hover:text-zinc-300'"
            @click="viewMode = 'chunks'"
          >
            <Icon
              icon="lucide:layers"
              class="w-3 h-3 inline mr-1"
            />
            Chunks ({{ chunkCount }})
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
            <!-- Merged view -->
            <div
              v-if="viewMode === 'merged'"
              class="p-5"
            >
              <pre class="text-xs text-zinc-300 whitespace-pre-wrap font-mono leading-relaxed">{{ mergedText }}</pre>
            </div>

            <!-- Chunks view -->
            <div
              v-else
              class="divide-y divide-zinc-800/60"
            >
              <div
                v-for="chunk in sortedChunks"
                :key="chunk.id"
                class="px-5 py-3"
              >
                <div class="flex items-center gap-2 mb-1.5">
                  <span class="text-[10px] font-mono text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded">
                    Chunk #{{ (chunk.chunkIndex ?? 0) + 1 }}
                  </span>
                </div>
                <pre class="text-xs text-zinc-400 whitespace-pre-wrap font-mono leading-relaxed">{{ chunk.text }}</pre>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>
