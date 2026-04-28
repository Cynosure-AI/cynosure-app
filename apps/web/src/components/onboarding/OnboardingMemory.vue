<template>
  <div class="max-w-2xl mx-auto px-4 py-6 w-full">
    <div class="mb-6">
      <h2 class="text-xl font-bold text-zinc-100">
        Set Up Memory
      </h2>
      <p class="text-sm text-zinc-500 mt-1">
        Give your agents searchable, long-term memory. Choose an embedding model and create a memory space.
        You can skip this and configure it later in Settings.
      </p>
    </div>

    <!-- Embedding Config -->
    <div class="bg-zinc-800/50 border border-zinc-700/60 rounded-xl p-5 space-y-4 mb-4">
      <h3 class="text-sm font-semibold text-zinc-200">
        Embeddings Provider
      </h3>

      <!-- Provider select -->
      <div>
        <label class="block text-xs font-medium text-zinc-400 mb-1.5">Provider</label>
        <select
          v-model="embProviderId"
          class="w-full bg-zinc-900 border border-zinc-600 text-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">
            Select a provider…
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

      <!-- Model -->
      <div>
        <label class="block text-xs font-medium text-zinc-400 mb-1.5">Embedding Model</label>
        <div class="flex gap-2">
          <div class="flex-1">
            <input
              v-if="!embModels.length"
              v-model="embModel"
              type="text"
              placeholder="e.g. text-embedding-3-small"
              class="w-full bg-zinc-900 border border-zinc-600 text-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-600"
            >
            <select
              v-else
              v-model="embModel"
              class="w-full bg-zinc-900 border border-zinc-600 text-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">
                Select model…
              </option>
              <option
                v-for="m in embModels"
                :key="m"
                :value="m"
              >
                {{ m }}
              </option>
            </select>
          </div>
        </div>
      </div>

      <!-- Dimensions -->
      <div>
        <label class="block text-xs font-medium text-zinc-400 mb-1.5">Vector Dimensions</label>
        <div class="flex gap-2 items-center">
          <input
            v-model.number="embDimensions"
            type="number"
            min="1"
            step="1"
            class="w-32 bg-zinc-900 border border-zinc-600 text-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
          <button
            class="flex items-center gap-1.5 px-3 py-2 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 text-zinc-300 text-sm rounded-lg transition-colors"
            :disabled="probing || !embModel"
            @click="probeDimensions"
          >
            <Icon
              :icon="probing ? 'lucide:loader-2' : 'lucide:wand-2'"
              class="w-3.5 h-3.5"
              :class="{ 'animate-spin': probing }"
            />
            {{ probing ? 'Detecting…' : 'Auto-detect' }}
          </button>
        </div>
        <p class="text-xs text-zinc-600 mt-1">
          Dimensions must match the embedding model output.
        </p>
      </div>

      <!-- Save embeddings button -->
      <button
        class="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
        :disabled="!embModel || !embDimensions || savingEmb"
        @click="saveEmbeddings"
      >
        <Icon
          :icon="savingEmb ? 'lucide:loader-2' : embSaved ? 'lucide:check' : 'lucide:save'"
          class="w-4 h-4"
          :class="{ 'animate-spin': savingEmb }"
        />
        {{ savingEmb ? 'Saving…' : embSaved ? 'Saved!' : 'Save Embedding Config' }}
      </button>
    </div>

    <!-- Memory Space -->
    <div class="bg-zinc-800/50 border border-zinc-700/60 rounded-xl p-5 space-y-4">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold text-zinc-200">
          Create a Memory Space
        </h3>
        <span
          v-if="createdSpace"
          class="text-xs text-emerald-400 flex items-center gap-1"
        >
          <Icon
            icon="lucide:check-circle-2"
            class="w-3.5 h-3.5"
          />
          Created
        </span>
      </div>
      <p class="text-xs text-zinc-500">
        A memory space organises documents your agents can retrieve. You can create more later.
      </p>

      <div v-if="!createdSpace">
        <label class="block text-xs font-medium text-zinc-400 mb-1.5">Space Name</label>
        <div class="flex gap-2">
          <input
            v-model="spaceName"
            type="text"
            placeholder="e.g. Personal Knowledge Base"
            class="flex-1 bg-zinc-900 border border-zinc-600 text-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-600"
          >
          <button
            class="flex items-center gap-1.5 px-3 py-2 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 text-zinc-300 text-sm rounded-lg transition-colors shrink-0"
            :disabled="!spaceName.trim() || creatingSpace"
            @click="createSpace"
          >
            <Icon
              :icon="creatingSpace ? 'lucide:loader-2' : 'lucide:plus'"
              class="w-4 h-4"
              :class="{ 'animate-spin': creatingSpace }"
            />
            {{ creatingSpace ? 'Creating…' : 'Create' }}
          </button>
        </div>
      </div>
      <div
        v-else
        class="flex items-center gap-3 bg-zinc-900/60 border border-emerald-500/20 rounded-lg px-4 py-3"
      >
        <Icon
          icon="lucide:brain"
          class="w-4 h-4 text-emerald-400 shrink-0"
        />
        <span class="text-sm text-zinc-200">
          <strong class="text-zinc-100">{{ createdSpace.name }}</strong> — memory space ready
        </span>
      </div>

      <p
        v-if="spaceError"
        class="text-xs text-red-400"
      >
        {{ spaceError }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { Icon } from '@iconify/vue'
import { useProviderStore } from '../../stores/provider.store'
import { api } from '../../api/client'
import type { MemorySpace } from '../../api/types'

const providerStore = useProviderStore()

const embProviderId = ref('')
const embModel = ref('')
const embDimensions = ref(1536)
const embModels = ref<string[]>([])
const probing = ref(false)
const savingEmb = ref(false)
const embSaved = ref(false)

const spaceName = ref('Personal Knowledge Base')
const creatingSpace = ref(false)
const createdSpace = ref<MemorySpace | null>(null)
const spaceError = ref('')

onMounted(async () => {
  await providerStore.loadProviders()
  try {
    const cfg = await api.memory.getEmbeddingConfig()
    if (cfg.providerId) embProviderId.value = cfg.providerId
    embModel.value = cfg.model
    embDimensions.value = cfg.dimensions
    if (cfg.providerId) fetchEmbModels(cfg.providerId)
  } catch { /* first run */ }
})

watch(embProviderId, (id) => {
  fetchEmbModels(id)
})

async function fetchEmbModels(providerId: string) {
  if (!providerId) { embModels.value = []; return }
  try {
    embModels.value = await providerStore.listModels(providerId, 'embedding')
  } catch { embModels.value = [] }
}

async function probeDimensions() {
  if (!embModel.value) return
  probing.value = true
  try {
    const res = await api.memory.probeEmbedding({
      providerId: embProviderId.value || undefined,
      model: embModel.value,
    })
    embDimensions.value = res.dimensions
  } catch { /* probe failed */ }
  probing.value = false
}

async function saveEmbeddings() {
  if (!embModel.value || !embDimensions.value) return
  savingEmb.value = true
  embSaved.value = false
  try {
    await api.memory.configureEmbeddings({
      providerId: embProviderId.value || undefined,
      model: embModel.value,
      dimensions: embDimensions.value,
    })
    embSaved.value = true
    setTimeout(() => { embSaved.value = false }, 2000)
  } catch { /* ignore */ }
  savingEmb.value = false
}

async function createSpace() {
  if (!spaceName.value.trim()) return
  creatingSpace.value = true
  spaceError.value = ''
  try {
    createdSpace.value = await api.memorySpaces.create(spaceName.value.trim())
  } catch (e) {
    spaceError.value = e instanceof Error ? e.message : 'Failed to create memory space'
  } finally {
    creatingSpace.value = false
  }
}
</script>
