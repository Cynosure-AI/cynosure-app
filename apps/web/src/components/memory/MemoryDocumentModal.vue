<script setup lang="ts">
import { computed, ref } from 'vue'
import { Icon } from '@iconify/vue'
import { api } from '../../api/client'

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

const emit = defineEmits<{
  close: []
  chunkUpdated: [chunkId: string, newText: string]
}>()

const sortedChunks = computed(() =>
  [...props.chunks].sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0))
)

// --- Inline chunk editing ---
const editingChunkId = ref<string | null>(null)
const editingText = ref('')
const savingChunkId = ref<string | null>(null)
const editError = ref<string | null>(null)

function startEdit(chunk: MemoryEntry) {
  editingChunkId.value = chunk.id
  editingText.value = chunk.text
  editError.value = null
}

function cancelEdit() {
  editingChunkId.value = null
  editingText.value = ''
  editError.value = null
}

async function saveChunk(chunk: MemoryEntry) {
  const newText = editingText.value.trim()
  if (!newText || newText === chunk.text) {
    cancelEdit()
    return
  }
  savingChunkId.value = chunk.id
  editError.value = null
  try {
    await api.memorySpaces.updateEntry(props.spaceId, chunk.id, newText)
    emit('chunkUpdated', chunk.id, newText)
    cancelEdit()
  } catch (err) {
    editError.value = (err as Error).message || 'Failed to save'
  } finally {
    savingChunkId.value = null
  }
}
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
                  <button
                    v-if="editingChunkId !== chunk.id"
                    class="opacity-0 group-hover:opacity-100 p-1 text-theme-600 hover:text-theme-300 rounded transition-all"
                    title="Edit chunk"
                    @click="startEdit(chunk)"
                  >
                    <Icon
                      icon="lucide:pencil"
                      class="w-3 h-3"
                    />
                  </button>
                </div>

                <!-- View mode -->
                <pre
                  v-if="editingChunkId !== chunk.id"
                  class="text-xs text-theme-400 whitespace-pre-wrap font-mono leading-relaxed"
                >{{ chunk.text }}</pre>

                <!-- Edit mode -->
                <template v-else>
                  <textarea
                    v-model="editingText"
                    class="w-full text-xs text-theme-200 bg-theme-800 border border-theme-600 rounded-lg p-2 font-mono leading-relaxed resize-y focus:outline-none focus:border-theme-400 transition-colors"
                    rows="6"
                    :disabled="savingChunkId === chunk.id"
                  />
                  <div
                    v-if="editError"
                    class="mt-1 text-xs text-red-400"
                  >
                    {{ editError }}
                  </div>
                  <div class="flex items-center gap-2 mt-2">
                    <button
                      :disabled="savingChunkId === chunk.id || !editingText.trim()"
                      class="flex items-center gap-1 px-2.5 py-1 text-xs bg-accent-500/15 text-accent-400 hover:bg-accent-500/25 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      @click="saveChunk(chunk)"
                    >
                      <Icon
                        :icon="savingChunkId === chunk.id ? 'lucide:loader-2' : 'lucide:check'"
                        class="w-3 h-3"
                        :class="{ 'animate-spin': savingChunkId === chunk.id }"
                      />
                      {{ savingChunkId === chunk.id ? 'Saving…' : 'Save & re-embed' }}
                    </button>
                    <button
                      :disabled="savingChunkId === chunk.id"
                      class="px-2.5 py-1 text-xs text-theme-500 hover:text-theme-300 transition-colors disabled:opacity-50"
                      @click="cancelEdit"
                    >
                      Cancel
                    </button>
                  </div>
                </template>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>
