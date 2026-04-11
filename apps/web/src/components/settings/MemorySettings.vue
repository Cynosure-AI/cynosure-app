<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useProviderStore } from '../../stores/provider.store'
import { api } from '../../api/client'
import { Icon } from '@iconify/vue'
import ModalDialog from '../shared/ModalDialog.vue'

const providerStore = useProviderStore()

// Embedding state
const embProviderId = ref('')
const embModel = ref('')
const embDimensions = ref(1536)
const embModels = ref<string[]>([])
const embLoadingModels = ref(false)
const embSaving = ref(false)
const embDirty = ref(false)
const embProbing = ref(false)

// Chunking state
const chunkSize = ref(512)
const chunkOverlap = ref(64)
const chunkSaving = ref(false)

// Confirmation dialog
const showDropConfirm = ref(false)

// Re-embed progress
const reembedProgress = ref<{ current: number; total: number; status: string } | null>(null)
const reembedPercent = computed(() => {
  if (!reembedProgress.value || reembedProgress.value.total === 0) return 0
  return Math.round((reembedProgress.value.current / reembedProgress.value.total) * 100)
})

let unsubReembed: (() => void) | null = null
onMounted(() => {
  unsubReembed = api.memory.onReembedProgress((data) => {
    reembedProgress.value = data
    if (data.status === 'completed') {
      setTimeout(() => { reembedProgress.value = null }, 2000)
    }
  })
})
onUnmounted(() => {
  unsubReembed?.()
})

// Manual clear
const showManualClear = ref(false)
const clearingDb = ref(false)

onMounted(async () => {
  await providerStore.loadProviders()
  await loadEmbeddingConfig()
  await loadChunkingConfig()
})

async function loadEmbeddingConfig() {
  try {
    const config = await api.memory.getEmbeddingConfig()
    embProviderId.value = config.providerId || ''
    embModel.value = config.model
    embDimensions.value = config.dimensions
    if (embProviderId.value) {
      fetchEmbModels(embProviderId.value)
    }
  } catch { /* first load, defaults are fine */ }
}

async function loadChunkingConfig() {
  try {
    const config = await api.memory.getChunkingConfig()
    chunkSize.value = config.chunkSize
    chunkOverlap.value = config.chunkOverlap
  } catch { /* defaults */ }
}

async function saveChunking() {
  chunkSaving.value = true
  try {
    await api.memory.configureChunking({
      chunkSize: chunkSize.value,
      chunkOverlap: chunkOverlap.value
    })
  } catch { /* error handling */ }
  chunkSaving.value = false
}

async function fetchEmbModels(providerId: string) {
  if (!providerId) { embModels.value = []; return }
  embLoadingModels.value = true
  try {
    embModels.value = await providerStore.listModels(providerId, 'embedding')
  } catch { embModels.value = [] }
  embLoadingModels.value = false
}

watch(embProviderId, (id) => {
  embDirty.value = true
  fetchEmbModels(id)
})
watch(embModel, () => { embDirty.value = true })
watch(embDimensions, () => { embDirty.value = true })

async function probeDimensions() {
  if (!embModel.value) return
  embProbing.value = true
  try {
    const res = await api.memory.probeEmbedding({
      providerId: embProviderId.value || undefined,
      model: embModel.value
    })
    embDimensions.value = res.dimensions
  } catch { /* probe failed */ }
  embProbing.value = false
}

async function saveEmbeddings() {
  // Check if model changed — warn about vector drop
  try {
    const current = await api.memory.getEmbeddingConfig()
    if (current.model !== embModel.value || current.dimensions !== embDimensions.value) {
      showDropConfirm.value = true
      return
    }
  } catch { /* no current config, safe to save */ }
  await doSaveEmbeddings(false)
}

async function doSaveEmbeddings(reembed: boolean) {
  embSaving.value = true
  try {
    await api.memory.configureEmbeddings({
      providerId: embProviderId.value || undefined,
      model: embModel.value,
      dimensions: embDimensions.value,
      reembed
    })
    embDirty.value = false
  } catch { /* error handling */ }
  embSaving.value = false
  showDropConfirm.value = false
}

async function confirmReembed() {
  await doSaveEmbeddings(true)
}

async function confirmDrop() {
  await doSaveEmbeddings(false)
}

function cancelDrop() {
  showDropConfirm.value = false
}

async function manualClearDb() {
  clearingDb.value = true
  try {
    await api.memory.dropVectors()
  } catch { /* error handling */ }
  clearingDb.value = false
  showManualClear.value = false
}

</script>

<template>
  <div>
    <h2 class="text-lg font-semibold text-zinc-200 mb-4">
      Memory & Embeddings
    </h2>

    <!-- Embedding Model -->
    <div class="rounded-lg border border-zinc-700 bg-zinc-800 p-4 space-y-4 mb-4">
      <div>
        <h3 class="text-sm font-medium text-zinc-200 mb-1">
          Embedding Model
        </h3>
        <p class="text-xs text-zinc-500">
          Select which provider and model to use for generating vector embeddings.
          Changing the model will offer to re-embed existing memories or drop them.
        </p>
        <p class="text-xs text-zinc-500 mt-1">
          For local embeddings we recommend <span class="text-zinc-300 font-medium">mxbai-embed-large</span> for
          best retrieval quality.
        </p>
      </div>

      <div class="space-y-3">
        <div>
          <label class="block text-xs text-zinc-400 mb-1">Provider</label>
          <select
            v-model="embProviderId"
            class="w-full px-3 py-2 bg-zinc-900 border border-zinc-600 rounded-lg text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">
              Use active provider (fallback)
            </option>
            <option
              v-for="p in providerStore.providers"
              :key="p.id"
              :value="p.id"
            >
              {{ p.name }}
            </option>
          </select>
        </div>

        <div>
          <label class="block text-xs text-zinc-400 mb-1">Model</label>
          <div class="flex gap-2">
            <select
              v-if="embModels.length > 0"
              v-model="embModel"
              class="flex-1 px-3 py-2 bg-zinc-900 border border-zinc-600 rounded-lg text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option
                v-for="m in embModels"
                :key="m"
                :value="m"
              >
                {{ m }}
              </option>
            </select>
            <input
              v-else
              v-model="embModel"
              type="text"
              placeholder="text-embedding-3-small"
              class="flex-1 px-3 py-2 bg-zinc-900 border border-zinc-600 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
            <button
              :disabled="embLoadingModels || !embProviderId"
              class="px-3 py-2 bg-zinc-700 hover:bg-zinc-600 disabled:bg-zinc-800 disabled:text-zinc-600 text-zinc-300 text-sm rounded-lg transition-colors"
              @click="fetchEmbModels(embProviderId)"
            >
              <Icon
                v-if="embLoadingModels"
                icon="lucide:loader-2"
                class="w-4 h-4 animate-spin"
              />
              <Icon
                v-else
                icon="lucide:refresh-cw"
                class="w-4 h-4"
              />
            </button>
          </div>
        </div>

        <div>
          <label class="block text-xs text-zinc-400 mb-1">Dimensions</label>
          <div class="flex gap-2 items-center">
            <input
              v-model.number="embDimensions"
              type="number"
              min="64"
              max="8192"
              class="w-32 px-3 py-2 bg-zinc-900 border border-zinc-600 rounded-lg text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
            <button
              :disabled="embProbing || !embModel"
              class="px-3 py-2 bg-zinc-700 hover:bg-zinc-600 disabled:bg-zinc-800 disabled:text-zinc-600 text-zinc-300 text-xs rounded-lg transition-colors flex items-center gap-1.5"
              @click="probeDimensions"
            >
              <Icon
                v-if="embProbing"
                icon="lucide:loader-2"
                class="w-3.5 h-3.5 animate-spin"
              />
              <Icon
                v-else
                icon="lucide:scan-search"
                class="w-3.5 h-3.5"
              />
              Detect
            </button>
          </div>
        </div>
      </div>

      <button
        :disabled="embSaving || !embModel"
        class="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm rounded-lg transition-colors"
        @click="saveEmbeddings"
      >
        <span v-if="embSaving">Saving...</span>
        <span v-else>Save Embedding Config</span>
      </button>
    </div>

    <!-- Chunking -->
    <div class="rounded-lg border border-zinc-700 bg-zinc-800 p-4 space-y-4 mb-4">
      <div>
        <h3 class="text-sm font-medium text-zinc-200 mb-1">
          Chunking
        </h3>
        <p class="text-xs text-zinc-500">
          Controls how documents are split before embedding. Larger chunks retain more context,
          smaller chunks improve retrieval precision. Overlap ensures context isn't lost at chunk boundaries.
        </p>
      </div>

      <div class="space-y-3">
        <div>
          <label class="block text-xs text-zinc-400 mb-1">Chunk Size (characters)</label>
          <input
            v-model.number="chunkSize"
            type="number"
            min="100"
            max="10000"
            step="64"
            class="w-40 px-3 py-2 bg-zinc-900 border border-zinc-600 rounded-lg text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
        </div>
        <div>
          <label class="block text-xs text-zinc-400 mb-1">Chunk Overlap (characters)</label>
          <input
            v-model.number="chunkOverlap"
            type="number"
            min="0"
            :max="chunkSize - 1"
            step="16"
            class="w-40 px-3 py-2 bg-zinc-900 border border-zinc-600 rounded-lg text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
        </div>
      </div>

      <button
        :disabled="chunkSaving"
        class="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm rounded-lg transition-colors"
        @click="saveChunking"
      >
        <span v-if="chunkSaving">Saving...</span>
        <span v-else>Save Chunking Config</span>
      </button>
    </div>

    <!-- Danger Zone -->
    <div class="rounded-lg mt-4 border border-red-900/50 bg-zinc-800 p-4 space-y-3">
      <div>
        <h3 class="text-sm font-medium text-zinc-200 mb-1">
          Danger Zone
        </h3>
        <p class="text-xs text-zinc-500">
          Clear all stored vector embeddings. This will remove all permanent memories across all agents.
          You will need to re-upload any knowledge files afterwards.
        </p>
      </div>
      <button
        class="px-4 py-2 bg-red-600/80 hover:bg-red-500 text-white text-sm rounded-lg transition-colors"
        @click="showManualClear = true"
      >
        Clear Vector Database
      </button>
    </div>

    <!-- Model change confirmation modal -->
    <ModalDialog
      :show="showDropConfirm"
      title="Embedding Model Changed"
      icon="lucide:alert-triangle"
      icon-color="amber"
      @close="cancelDrop"
    >
      <p class="text-zinc-400 leading-relaxed">
        Changing the embedding model or dimensions makes existing vectors incompatible.
        You can <strong class="text-zinc-200">re-embed</strong> all stored memories with the new model to preserve your data,
        or <strong class="text-zinc-200">drop</strong> all vectors and re-upload files manually.
      </p>

      <!-- Re-embed progress bar -->
      <div
        v-if="reembedProgress"
        class="mt-4 space-y-2"
      >
        <div class="flex items-center justify-between text-xs text-zinc-400">
          <span>Re-embedding...</span>
          <span>{{ reembedProgress.current }} / {{ reembedProgress.total }} chunks ({{ reembedPercent }}%)</span>
        </div>
        <div class="w-full h-2 bg-zinc-700 rounded-full overflow-hidden">
          <div
            class="h-full bg-blue-500 rounded-full transition-all duration-300"
            :style="{ width: `${reembedPercent}%` }"
          />
        </div>
      </div>

      <template #actions>
        <button
          :disabled="embSaving"
          class="w-full px-4 py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 text-white rounded-xl text-center font-medium transition-colors"
          @click="confirmReembed"
        >
          {{ embSaving ? 'Re-Embedding...' : 'Re-Embed All Memories' }}
        </button>
        <button
          :disabled="embSaving"
          class="w-full px-4 py-3 bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-700 text-white rounded-xl text-center font-medium transition-colors"
          @click="confirmDrop"
        >
          {{ embSaving ? 'Saving...' : 'Drop & Save' }}
        </button>
        <button
          :disabled="embSaving"
          class="w-full px-4 py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl text-center font-medium transition-colors"
          @click="cancelDrop"
        >
          Cancel
        </button>
      </template>
    </ModalDialog>

    <!-- Manual clear confirmation modal -->
    <ModalDialog
      :show="showManualClear"
      title="Clear Vector Database"
      icon="lucide:trash-2"
      icon-color="red"
      @close="showManualClear = false"
    >
      <p class="text-zinc-400 leading-relaxed">
        This will permanently delete all stored vector embeddings and memories across all agents. You will need to re-upload any knowledge files afterwards.
      </p>
      <template #actions>
        <button
          :disabled="clearingDb"
          class="w-full px-4 py-3 bg-red-600 hover:bg-red-500 disabled:bg-zinc-700 text-white rounded-xl text-center font-medium transition-colors"
          @click="manualClearDb"
        >
          {{ clearingDb ? 'Clearing...' : 'Clear All Vectors' }}
        </button>
        <button
          class="w-full px-4 py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl text-center font-medium transition-colors"
          @click="showManualClear = false"
        >
          Cancel
        </button>
      </template>
    </ModalDialog>
  </div>
</template>
