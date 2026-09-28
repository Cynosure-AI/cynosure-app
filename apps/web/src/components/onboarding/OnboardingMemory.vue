<template>
  <div class="max-w-2xl mx-auto px-4 py-6 w-full">
    <div class="mb-6">
      <h2 class="text-xl font-bold text-theme-100">
        Set Up Memory
      </h2>
      <p class="text-sm text-theme-500 mt-1">
        Choose which provider Cynosure should use to turn documents and conversations into
        searchable memory. Cynosure recommends a strong default while leaving the final choice to you.
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

      <div v-if="embProviderId">
        <div class="mb-1.5 flex items-center justify-between gap-3">
          <label
            for="onboarding-embedding-model"
            class="block text-sm font-medium text-theme-300"
          >Embedding model</label>
          <span
            v-if="embDimensions"
            class="whitespace-nowrap text-[11px] text-theme-500"
          >{{ embDimensions }} dimensions</span>
        </div>

        <div class="relative">
          <select
            id="onboarding-embedding-model"
            v-model="embModel"
            :disabled="resolvingModel || !availableModels.length"
            class="w-full rounded-lg border border-theme-600 bg-theme-900 px-3 py-2.5 text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500 disabled:cursor-wait disabled:text-theme-500"
            @change="onEmbeddingModelChange"
          >
            <option
              v-if="resolvingModel"
              value=""
            >
              Finding embedding models…
            </option>
            <option
              v-else-if="!availableModels.length"
              value=""
            >
              No embedding model found
            </option>
            <option
              v-for="availableModel in availableModels"
              :key="availableModel"
              :value="availableModel"
            >
              {{ availableModel }}{{ availableModel === recommendedModel ? ' (Recommended)' : '' }}
            </option>
          </select>
          <Icon
            v-if="resolvingModel"
            icon="lucide:loader-2"
            class="pointer-events-none absolute right-8 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-theme-500"
          />
        </div>

        <p
          v-if="recommendedModel"
          class="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-theme-500"
        >
          <Icon
            icon="lucide:sparkles"
            class="mt-0.5 h-3 w-3 shrink-0 text-accent-fg"
          />
          We recommend <span class="font-mono text-theme-400">{{ recommendedModel }}</span> for this provider.
        </p>
        <p
          v-else-if="!resolvingModel && !availableModels.length"
          class="mt-2 text-[11px] text-theme-500"
        >
          This provider did not return an embedding model. You can configure one later in Settings → Memory.
        </p>
      </div>

      <button
        class="flex items-center gap-2 px-4 py-2 bg-accent-600 hover:bg-accent-500 disabled:opacity-50 text-accent-on text-sm font-medium rounded-lg transition-colors"
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
          class="w-5 h-5 text-accent-fg shrink-0 mt-0.5"
        />
        <div>
          <p class="text-sm font-medium text-accent-fg">
            Memory embeddings are ready
          </p>
          <p class="text-xs text-theme-400 mt-0.5">
            Cynosure can now index memory folders and retrieve relevant knowledge for your agents.
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
const availableModels = ref<string[]>([])
const recommendedModel = ref('')
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
    embDimensions.value = cfg.dimensions
    if (cfg.providerId) {
      embConfigured.value = true
      await resolveEmbeddingModel(cfg.providerId, cfg.model)
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
  availableModels.value = []
  recommendedModel.value = ''
  embConfigured.value = false
  embSaved.value = false
  void resolveEmbeddingModel(id)
})

async function resolveEmbeddingModel(providerId: string, preferredModel = '') {
  const requestId = ++modelRequest
  if (!providerId) {
    embModel.value = ''
    availableModels.value = []
    recommendedModel.value = ''
    resolvingModel.value = false
    return
  }

  resolvingModel.value = true
  embModel.value = preferredModel
  const defaultModel = defaultEmbeddingModelForProviderId(providerId, providerStore.providers)
  recommendedModel.value = defaultModel
  try {
    const models = await providerStore.listModels(providerId, 'embedding')
    if (requestId !== modelRequest) return
    const suggestedModels = withDefaultEmbeddingModel(models, defaultModel)
    availableModels.value = preferredModel && !suggestedModels.includes(preferredModel)
      ? [...suggestedModels, preferredModel]
      : suggestedModels
    embModel.value = preferredModel || availableModels.value[0] || ''
  } catch {
    if (requestId !== modelRequest) return
    availableModels.value = preferredModel
      ? [preferredModel, ...(defaultModel && defaultModel !== preferredModel ? [defaultModel] : [])]
      : defaultModel ? [defaultModel] : []
    embModel.value = preferredModel || defaultModel
  } finally {
    if (requestId === modelRequest) resolvingModel.value = false
  }
}

function onEmbeddingModelChange() {
  embDimensions.value = 0
  embConfigured.value = false
  embSaved.value = false
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
