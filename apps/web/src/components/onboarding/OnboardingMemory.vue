<template>
  <div class="max-w-2xl mx-auto px-4 py-6 w-full">
    <div class="mb-6">
      <h2 class="text-xl font-bold text-theme-100">
        Set Up Memory
      </h2>
      <p class="text-sm text-theme-500 mt-1">
        Give your agents searchable, long-term memory. Choose an embedding model to be able to use auto-memories and auto tool calling.
        You can skip this and configure it later in Settings.
      </p>
    </div>

    <!-- Embedding Config -->
    <div class="bg-theme-800/50 border border-theme-700/60 rounded-xl p-5 space-y-4 mb-4">
      <h3 class="text-sm font-semibold text-theme-200">
        Embeddings Provider
      </h3>

      <!-- Provider select -->
      <div>
        <label class="block text-xs font-medium text-theme-400 mb-1.5">Provider</label>
        <select
          v-model="embProviderId"
          class="w-full bg-theme-900 border border-theme-600 text-theme-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500"
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
        <div class="flex items-center justify-between gap-3 mb-1.5">
          <label class="block text-xs font-medium text-theme-400">Embedding Model</label>
          <span
            v-if="embDimensions"
            class="text-[11px] text-theme-500 whitespace-nowrap"
          >
            {{ embDimensions }} dimensions
          </span>
        </div>
        <div class="flex gap-2">
          <div class="flex-1">
            <input
              v-if="!embModels.length"
              v-model="embModel"
              type="text"
              placeholder="e.g. text-embedding-3-small"
              class="w-full bg-theme-900 border border-theme-600 text-theme-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500 placeholder-theme-600"
            >
            <select
              v-else
              v-model="embModel"
              class="w-full bg-theme-900 border border-theme-600 text-theme-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500"
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

      <!-- Save embeddings button -->
      <button
        class="flex items-center gap-2 px-4 py-2 bg-accent-600 hover:bg-accent-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
        :disabled="!embModel || savingEmb"
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

    <!-- Next step callout (shown after embeddings are saved) -->
    <Transition name="fade">
      <div
        v-if="embSaved || embConfigured"
        class="flex items-start gap-3 bg-accent-500/10 border border-accent-500/30 rounded-xl px-4 py-3.5"
      >
        <Icon
          icon="lucide:arrow-right-circle"
          class="w-5 h-5 text-accent-400 shrink-0 mt-0.5"
        />
        <div>
          <p class="text-sm font-medium text-accent-300">
            Embeddings configured!
          </p>
          <p class="text-xs text-theme-400 mt-0.5">
            Click <strong class="text-theme-200">Continue</strong> to set up your memory folder — a place to store and search documents for your agents.
          </p>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { Icon } from '@iconify/vue'
import { useProviderStore } from '../../stores/provider.store'
import { api } from '../../api/client'
import {
  defaultEmbeddingModelForProviderId,
  withDefaultEmbeddingModel,
} from '../../utils/embedding-defaults'

const providerStore = useProviderStore()

const embProviderId = ref('')
const embModel = ref('')
const embDimensions = ref(0)
const embModels = ref<string[]>([])
const savingEmb = ref(false)
const embSaved = ref(false)
const embConfigured = ref(false)
const loadingInitialConfig = ref(true)

onMounted(async () => {
  await providerStore.loadProviders()
  try {
    const cfg = await api.memory.getEmbeddingConfig()
    if (cfg.providerId) embProviderId.value = cfg.providerId
    embModel.value = cfg.model
    embDimensions.value = cfg.dimensions
    if (cfg.providerId) {
      fetchEmbModels(cfg.providerId)
      embConfigured.value = true
    } else {
      applyDefaultEmbeddingConfig()
    }
  } catch {
    applyDefaultEmbeddingConfig()
  }
  loadingInitialConfig.value = false
})

watch(embProviderId, (id) => {
  if (!loadingInitialConfig.value) {
    embModel.value = defaultEmbeddingModelForProviderId(id, providerStore.providers)
    embDimensions.value = 0
  }
  fetchEmbModels(id)
})

async function fetchEmbModels(providerId: string) {
  if (!providerId) { embModels.value = []; return }
  const defaultModel = defaultEmbeddingModelForProviderId(providerId, providerStore.providers)
  try {
    const models = await providerStore.listModels(providerId, 'embedding')
    embModels.value = withDefaultEmbeddingModel(models, defaultModel)
  } catch { embModels.value = withDefaultEmbeddingModel([], defaultModel) }
}

function applyDefaultEmbeddingConfig() {
  const providerId = providerStore.lastUsedProviderId || providerStore.providers[0]?.id || ''
  const defaultModel = defaultEmbeddingModelForProviderId(providerId, providerStore.providers)
  if (!providerId || !defaultModel) return
  embProviderId.value = providerId
  embModel.value = defaultModel
  embDimensions.value = 0
  fetchEmbModels(providerId)
}

async function saveEmbeddings() {
  if (!embModel.value) return
  savingEmb.value = true
  embSaved.value = false
  try {
    const res = await api.memory.configureEmbeddings({
      providerId: embProviderId.value || undefined,
      model: embModel.value,
    })
    embDimensions.value = res.dimensions
    embSaved.value = true
    embConfigured.value = true
    setTimeout(() => { embSaved.value = false }, 3000)
  } catch { /* ignore */ }
  savingEmb.value = false
}
</script>

<style scoped>
.fade-enter-from { opacity: 0; transform: translateY(-6px); }
.fade-enter-active { transition: opacity 0.3s ease, transform 0.3s ease; }
.fade-leave-to { opacity: 0; }
.fade-leave-active { transition: opacity 0.2s ease; }
</style>
