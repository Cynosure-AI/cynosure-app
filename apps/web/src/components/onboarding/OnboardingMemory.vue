<template>
  <div class="max-w-2xl mx-auto px-4 py-6 w-full">
    <div class="mb-6">
      <h2 class="text-xl font-bold text-theme-100">
        Set Up Memory
      </h2>
      <p class="text-sm text-theme-500 mt-1">
        Choose which provider Cynosure should use to turn documents and conversations into
        searchable memory. We’ll select a suitable embedding model automatically.
      </p>
    </div>

    <div class="bg-theme-800/50 border border-theme-700/60 rounded-xl p-5 space-y-4 mb-4">
      <div>
        <label class="block text-sm font-medium text-theme-300 mb-1.5">
          Memory embedding provider
        </label>
        <p class="text-xs text-theme-500 mb-3">
          OpenAI, Google, and OpenRouter have recommended defaults. Other providers are supported
          when they expose embedding models.
        </p>
        <select
          v-model="embProviderId"
          class="w-full bg-theme-900 border border-theme-600 text-theme-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500"
        >
          <option value="">
            Select a provider…
          </option>
          <option
            v-for="provider in providerStore.providers"
            :key="provider.id"
            :value="provider.id"
          >
            {{ provider.name }}
          </option>
        </select>
      </div>

      <div
        v-if="embProviderId"
        class="flex items-start gap-2.5 rounded-lg border border-theme-700/60 bg-theme-900/50 px-3.5 py-3"
      >
        <Icon
          :icon="resolvingModel ? 'lucide:loader-2' : embModel ? 'lucide:sparkles' : 'lucide:triangle-alert'"
          class="w-4 h-4 mt-0.5 shrink-0"
          :class="[
            resolvingModel ? 'animate-spin text-theme-500' : '',
            !resolvingModel && embModel ? 'text-accent-400' : '',
            !resolvingModel && !embModel ? 'text-amber-400' : '',
          ]"
        />
        <div class="min-w-0">
          <p class="text-xs font-medium text-theme-300">
            {{ resolvingModel ? 'Finding an embedding model…' : embModel ? 'Embedding model selected automatically' : 'No embedding model found' }}
          </p>
          <p
            v-if="!resolvingModel && embModel"
            class="text-[11px] text-theme-500 mt-0.5 font-mono truncate"
          >
            {{ embModel }}<span v-if="embDimensions"> · {{ embDimensions }} dimensions</span>
          </p>
          <p
            v-else-if="!resolvingModel"
            class="text-[11px] text-theme-500 mt-0.5"
          >
            You can configure a model manually later in Settings → Memory.
          </p>
        </div>
      </div>

      <button
        class="flex items-center gap-2 px-4 py-2 bg-accent-600 hover:bg-accent-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
        :disabled="!embProviderId || !embModel || savingEmb || resolvingModel"
        @click="saveEmbeddings"
      >
        <Icon
          :icon="savingEmb ? 'lucide:loader-2' : embSaved ? 'lucide:check' : 'lucide:save'"
          class="w-4 h-4"
          :class="{ 'animate-spin': savingEmb }"
        />
        {{ savingEmb ? 'Configuring…' : embSaved ? 'Memory configured!' : 'Configure Memory' }}
      </button>
    </div>

    <Transition name="fade">
      <div
        v-if="embSaved || embConfigured"
        class="flex items-start gap-3 bg-accent-500/10 border border-accent-500/30 rounded-xl px-4 py-3.5"
      >
        <Icon
          icon="lucide:check-circle-2"
          class="w-5 h-5 text-accent-400 shrink-0 mt-0.5"
        />
        <div>
          <p class="text-sm font-medium text-accent-300">
            Memory embeddings are ready
          </p>
          <p class="text-xs text-theme-400 mt-0.5">
            Cynosure can now index memory spaces and retrieve relevant knowledge for your agents.
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
const savingEmb = ref(false)
const embSaved = ref(false)
const embConfigured = ref(false)
const loadingInitialConfig = ref(true)
const resolvingModel = ref(false)
let modelRequest = 0

onMounted(async () => {
  await providerStore.loadProviders()
  try {
    const cfg = await api.memory.getEmbeddingConfig()
    if (cfg.providerId) embProviderId.value = cfg.providerId
    embModel.value = cfg.model
    embDimensions.value = cfg.dimensions
    if (cfg.providerId) {
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
  if (loadingInitialConfig.value) return
  embDimensions.value = 0
  embConfigured.value = false
  embSaved.value = false
  void resolveEmbeddingModel(id)
})

async function resolveEmbeddingModel(providerId: string) {
  const requestId = ++modelRequest
  if (!providerId) {
    embModel.value = ''
    resolvingModel.value = false
    return
  }

  resolvingModel.value = true
  const defaultModel = defaultEmbeddingModelForProviderId(providerId, providerStore.providers)
  try {
    const models = await providerStore.listModels(providerId, 'embedding')
    if (requestId !== modelRequest) return
    embModel.value = withDefaultEmbeddingModel(models, defaultModel)[0] || ''
  } catch {
    if (requestId !== modelRequest) return
    embModel.value = defaultModel
  } finally {
    if (requestId === modelRequest) resolvingModel.value = false
  }
}

function applyDefaultEmbeddingConfig() {
  const providerId = providerStore.lastUsedProviderId || providerStore.providers[0]?.id || ''
  if (!providerId) return
  embProviderId.value = providerId
  embDimensions.value = 0
  void resolveEmbeddingModel(providerId)
}

async function saveEmbeddings() {
  if (!embProviderId.value || !embModel.value) return
  savingEmb.value = true
  embSaved.value = false
  try {
    const res = await api.memory.configureEmbeddings({
      providerId: embProviderId.value,
      model: embModel.value,
    })
    embDimensions.value = res.dimensions
    embSaved.value = true
    embConfigured.value = true
    setTimeout(() => { embSaved.value = false }, 3000)
  } catch {
    // Settings remains optional during onboarding.
  } finally {
    savingEmb.value = false
  }
}
</script>

<style scoped>
.fade-enter-from { opacity: 0; transform: translateY(-6px); }
.fade-enter-active { transition: opacity 0.3s ease, transform 0.3s ease; }
.fade-leave-to { opacity: 0; }
.fade-leave-active { transition: opacity 0.2s ease; }
</style>
