<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useProviderStore } from '../../stores/provider.store'
import { usePreferencesStore } from '../../stores/preferences.store'
import { api } from '../../api/client'
import { Icon } from '@iconify/vue'
import ModalDialog from '../shared/ModalDialog.vue'
import ProviderSelect from '../shared/ProviderSelect.vue'
import ProviderModelSelect from '../shared/ProviderModelSelect.vue'
import BaseCard from '../shared/BaseCard.vue'
import ToggleSwitch from '../shared/ToggleSwitch.vue'
import SettingsSubheading from './SettingsSubheading.vue'
import SettingsPersistenceStatus, { type SettingsPersistenceState } from './SettingsPersistenceStatus.vue'
import {
  defaultEmbeddingModelForProviderId,
} from '../../utils/embedding-defaults'

const providerStore = useProviderStore()
const prefs = usePreferencesStore()
const props = withDefaults(defineProps<{
  visibleSections?: string[]
}>(), {
  visibleSections: () => []
})
const emit = defineEmits<{ 'dirty-change': [dirty: boolean] }>()

function showSection(id: string): boolean {
  return props.visibleSections.length === 0 || props.visibleSections.includes(id)
}

function showAnySection(ids: string[]): boolean {
  return ids.some(showSection)
}

const dreamEnabled = ref(false)
const dreamProviderId = ref('')
const dreamModel = ref('')
const dreamSaving = ref(false)
const dreamLoaded = ref(false)
const dreamError = ref('')

async function loadDreamConfig() {
  try {
    const config = await api.memory.getDreamConfig()
    dreamEnabled.value = config.enabled
    dreamProviderId.value = config.providerId
    dreamModel.value = config.model
    dreamLoaded.value = true
  } catch (error) {
    dreamError.value = error instanceof Error ? error.message : 'Could not load Dream settings.'
  }
}
async function saveDream() {
  dreamSaving.value = true
  dreamError.value = ''
  try {
    const config = await api.memory.configureDream({ enabled: dreamEnabled.value, providerId: dreamProviderId.value, model: dreamModel.value })
    dreamEnabled.value = config.enabled
    dreamProviderId.value = config.providerId
    dreamModel.value = config.model
  } catch (error) {
    dreamError.value = error instanceof Error ? error.message : 'Could not save Dream settings.'
  } finally {
    dreamSaving.value = false
  }
}

// Embedding state
const embProviderId = ref('')
const embModel = ref('')
const embDimensions = ref(1536)
const embModelRefreshKey = ref(0)

const embSaving = ref(false)
const savedEmbedding = ref({ providerId: '', model: '' })
const embStatus = ref<SettingsPersistenceState>('idle')
const embProbing = ref(false)
const loadingEmbeddingConfig = ref(true)

// Chunking state
const chunkSize = ref(512)
const chunkOverlap = ref(64)
const chunkSaving = ref(false)
const savedChunking = ref({ chunkSize: 512, chunkOverlap: 64 })
const chunkStatus = ref<SettingsPersistenceState>('idle')

// Reranker state
const rerankEnabled = ref(false)
const rerankProviderId = ref('')
const rerankModel = ref('')
const rerankCandidateCount = ref(50)
const rerankSaving = ref(false)
const savedReranker = ref({ enabled: false, providerId: '', model: '', candidateCount: 50 })
const rerankStatus = ref<SettingsPersistenceState>('idle')

// Entity extraction state
const entityExtractionProviderId = ref('')
const entityExtractionModel = ref('')
const entityExtractionSaving = ref(false)
const entityExtractionStatus = ref<SettingsPersistenceState>('idle')

const embDirty = computed(() =>
  embProviderId.value !== savedEmbedding.value.providerId || embModel.value !== savedEmbedding.value.model
)
const chunkDirty = computed(() =>
  chunkSize.value !== savedChunking.value.chunkSize || chunkOverlap.value !== savedChunking.value.chunkOverlap
)
const rerankDirty = computed(() =>
  rerankEnabled.value !== savedReranker.value.enabled ||
  rerankProviderId.value !== savedReranker.value.providerId ||
  rerankModel.value !== savedReranker.value.model ||
  rerankCandidateCount.value !== savedReranker.value.candidateCount
)
const manualDirty = computed(() => embDirty.value || chunkDirty.value || rerankDirty.value)

watch(manualDirty, (dirty) => emit('dirty-change', dirty), { immediate: true })

const embeddingProviders = computed(() => {
  const provider = providerStore.providers.find((candidate) => candidate.id === embProviderId.value)
  return provider ? [provider] : []
})

const openRouterProviders = computed(() =>
  providerStore.providers.filter((provider) => provider.type === 'openrouter')
)

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

onMounted(async () => {
  await providerStore.loadProviders()
  await loadDreamConfig()
  await loadEmbeddingConfig()
  await loadEntityExtractionConfig()
  await loadChunkingConfig()
  await loadRerankerConfig()
})

async function loadEmbeddingConfig() {
  loadingEmbeddingConfig.value = true
  try {
    const config = await api.memory.getEmbeddingConfig()
    if (config.providerId) {
      embProviderId.value = config.providerId
      embModel.value = config.model
      embDimensions.value = config.dimensions
    } else {
      applyDefaultEmbeddingConfig()
    }
  } catch {
    applyDefaultEmbeddingConfig()
  }
  savedEmbedding.value = { providerId: embProviderId.value, model: embModel.value }
  loadingEmbeddingConfig.value = false
}

async function loadChunkingConfig() {
  try {
    const config = await api.memory.getChunkingConfig()
    chunkSize.value = config.chunkSize
    chunkOverlap.value = config.chunkOverlap
    savedChunking.value = { chunkSize: config.chunkSize, chunkOverlap: config.chunkOverlap }
  } catch { /* defaults */ }
}

async function saveChunking() {
  chunkSaving.value = true
  chunkStatus.value = 'saving'
  try {
    const config = await api.memory.configureChunking({
      chunkSize: chunkSize.value,
      chunkOverlap: chunkOverlap.value
    })
    chunkSize.value = config.chunkSize
    chunkOverlap.value = config.chunkOverlap
    savedChunking.value = { chunkSize: config.chunkSize, chunkOverlap: config.chunkOverlap }
    chunkStatus.value = 'saved'
  } catch {
    chunkStatus.value = 'error'
  }
  chunkSaving.value = false
}

async function loadRerankerConfig() {
  try {
    const config = await api.memory.getRerankerConfig()
    rerankEnabled.value = config.enabled
    rerankProviderId.value = config.providerId || openRouterProviders.value[0]?.id || ''
    rerankModel.value = config.model
    rerankCandidateCount.value = config.candidateCount
    savedReranker.value = {
      enabled: config.enabled,
      providerId: config.providerId || rerankProviderId.value,
      model: config.model,
      candidateCount: config.candidateCount,
    }
  } catch {
    rerankProviderId.value = openRouterProviders.value[0]?.id || ''
    savedReranker.value = {
      enabled: rerankEnabled.value,
      providerId: rerankProviderId.value,
      model: rerankModel.value,
      candidateCount: rerankCandidateCount.value,
    }
  }
}

async function loadEntityExtractionConfig() {
  try {
    const config = await api.memory.getEntityExtractionConfig()
    entityExtractionProviderId.value = config.providerId || ''
    entityExtractionModel.value = config.model || ''

    if (!entityExtractionProviderId.value && !entityExtractionModel.value && (prefs.knowledgeProviderId || prefs.knowledgeModel)) {
      await saveEntityExtractionSelection({
        providerId: prefs.knowledgeProviderId,
        model: prefs.knowledgeModel,
      })
    }
  } catch {
    entityExtractionProviderId.value = prefs.knowledgeProviderId || ''
    entityExtractionModel.value = prefs.knowledgeModel || ''
  }
}

async function saveEntityExtractionSelection(selection: { providerId: string; model: string }) {
  const previous = {
    providerId: entityExtractionProviderId.value,
    model: entityExtractionModel.value,
  }
  entityExtractionProviderId.value = selection.providerId
  entityExtractionModel.value = selection.model
  prefs.knowledgeProviderId = selection.providerId
  prefs.knowledgeModel = selection.model
  entityExtractionSaving.value = true
  entityExtractionStatus.value = 'saving'
  try {
    const res = await api.memory.configureEntityExtraction({
      providerId: selection.providerId || undefined,
      model: selection.model || undefined,
    })
    entityExtractionProviderId.value = res.providerId || ''
    entityExtractionModel.value = res.model || ''
    prefs.knowledgeProviderId = entityExtractionProviderId.value
    prefs.knowledgeModel = entityExtractionModel.value
    entityExtractionStatus.value = 'saved'
  } catch {
    entityExtractionProviderId.value = previous.providerId
    entityExtractionModel.value = previous.model
    prefs.knowledgeProviderId = previous.providerId
    prefs.knowledgeModel = previous.model
    entityExtractionStatus.value = 'error'
  }
  entityExtractionSaving.value = false
}

async function saveReranker() {
  rerankSaving.value = true
  rerankStatus.value = 'saving'
  try {
    const res = await api.memory.configureReranker({
      enabled: rerankEnabled.value,
      providerId: rerankProviderId.value || undefined,
      model: rerankModel.value,
      candidateCount: rerankCandidateCount.value
    })
    rerankEnabled.value = res.enabled
    rerankProviderId.value = res.providerId || rerankProviderId.value
    rerankModel.value = res.model
    rerankCandidateCount.value = res.candidateCount
    savedReranker.value = {
      enabled: res.enabled,
      providerId: res.providerId || rerankProviderId.value,
      model: res.model,
      candidateCount: res.candidateCount,
    }
    rerankStatus.value = 'saved'
  } catch {
    rerankStatus.value = 'error'
  }
  rerankSaving.value = false
}

function updateRerankerSelection(selection: { providerId: string; model: string }) {
  rerankProviderId.value = selection.providerId
  rerankModel.value = selection.model
}

function updateEmbeddingSelection(selection: { providerId: string; model: string }) {
  embProviderId.value = selection.providerId
  embModel.value = selection.model
}

watch(embProviderId, (id) => {
  if (loadingEmbeddingConfig.value) return
  const defaultModel = defaultEmbeddingModelForProviderId(id, providerStore.providers)
  if (defaultModel) embModel.value = defaultModel
}, { flush: 'sync' })

function applyDefaultEmbeddingConfig() {
  const providerId = providerStore.lastUsedProviderId || providerStore.providers[0]?.id || ''
  const defaultModel = defaultEmbeddingModelForProviderId(providerId, providerStore.providers)
  if (!providerId || !defaultModel) return
  embProviderId.value = providerId
  embModel.value = defaultModel
  embDimensions.value = 0
}

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
  await probeDimensions()
  // Check if model changed — warn about vector drop
  try {
    const current = await api.memory.getEmbeddingConfig()
    if (
      (current.providerId || '') !== embProviderId.value ||
      current.model !== embModel.value ||
      current.dimensions !== embDimensions.value
    ) {
      showDropConfirm.value = true
      return
    }
  } catch { /* no current config, safe to save */ }
  await doSaveEmbeddings(false)
}

async function doSaveEmbeddings(reembed: boolean) {
  embSaving.value = true
  embStatus.value = 'saving'
  try {
    const res = await api.memory.configureEmbeddings({
      providerId: embProviderId.value || undefined,
      model: embModel.value,
      reembed
    })
    embDimensions.value = res.dimensions
    savedEmbedding.value = { providerId: embProviderId.value, model: embModel.value }
    embStatus.value = 'saved'
  } catch {
    embStatus.value = 'error'
  }
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

</script>

<template>
  <div class="space-y-4">
    <BaseCard v-if="showSection('dream-mode')" class="p-5 space-y-4">
      <div class="flex items-center justify-between gap-4">
        <div>
          <h3 class="text-sm font-medium text-theme-200 flex items-center gap-2">
            <Icon icon="lucide:moon-star" class="w-5 h-5" />
            Dream Mode
            <span class="text-[10px] rounded px-2 py-0.5 bg-amber-400/10 text-amber-400">Experimental</span>
          </h3>
          <p class="text-xs text-theme-500 mt-1">
            Automatically reviews new chat and channel activity to learn useful facts and update memory.
            Checks every 5 minutes after a conversation has been inactive for 15 minutes, while the server is running.
            Uses model requests and may incur provider costs. Existing history is used only as context.
          </p>
        </div>
        <ToggleSwitch v-model="dreamEnabled" label="Enable Dream Mode" :disabled="!dreamLoaded || dreamSaving || (!dreamEnabled && (!dreamProviderId || !dreamModel))" />
      </div>
      <ProviderModelSelect
        :provider-id="dreamProviderId" :model-value="dreamModel" :providers="providerStore.providers"
        placeholder="Select Dream provider and model" dropdown-width="min-w-full"
        @change="(selection) => { dreamProviderId = selection.providerId; dreamModel = selection.model }"
      />
      <p v-if="dreamError" role="alert" class="text-xs text-red-400">{{ dreamError }}</p>
      <button :disabled="!dreamLoaded || dreamSaving || (dreamEnabled && (!dreamProviderId || !dreamModel))"
        class="px-4 py-2 bg-accent-600 hover:bg-accent-500 disabled:bg-theme-700 disabled:text-theme-500 text-white text-sm rounded-lg"
        @click="saveDream">
        {{ dreamSaving ? 'Saving...' : 'Save Dream Config' }}
      </button>
    </BaseCard>
    <SettingsSubheading
      v-if="showAnySection(['embedding-model', 'knowledge-extraction', 'reranker'])"
      label="Retrieval"
    />

    <!-- Embedding Model -->
    <BaseCard
      v-if="showSection('embedding-model')"
      class="p-5 space-y-4"
    >
      <div class="flex items-start gap-3">
        <div class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center shrink-0">
          <Icon
            icon="lucide:layers"
            class="w-5 h-5 text-theme-400"
          />
        </div>
        <div>
          <h3 class="text-sm font-medium text-theme-200">
            Embedding Model
          </h3>
          <p class="text-xs text-theme-500 mt-0.5">
            Select the provider and model for vector embeddings. Changing the model will offer to re-embed existing memories or drop them.
            For local embeddings, <span class="text-theme-300 font-medium">mxbai-embed-large</span> gives the best retrieval quality.
          </p>
        </div>
      </div>

      <div class="space-y-3">
        <div>
          <label class="block text-xs text-theme-400 mb-1">Provider</label>
          <ProviderSelect
            v-model="embProviderId"
            :providers="providerStore.providers"
            include-default
            default-label="Use active provider (fallback)"
            placeholder="Use active provider (fallback)"
          />
        </div>

        <div>
          <div class="flex items-center justify-between gap-3 mb-1">
            <label class="block text-xs text-theme-400">Model</label>
            <span
              v-if="embDimensions"
              class="text-[11px] text-theme-500 whitespace-nowrap"
            >
              {{ embDimensions }} dimensions
            </span>
          </div>
          <div class="flex gap-2">
            <ProviderModelSelect
              class="flex-1"
              :provider-id="embProviderId"
              :model-value="embModel"
              :providers="embeddingProviders"
              model-type="embedding"
              :include-provider-default="false"
              :refresh-key="embModelRefreshKey"
              placeholder="Select embedding model"
              dropdown-width="min-w-full"
              max-height="max-h-72"
              @change="updateEmbeddingSelection"
            />
            <button
              :disabled="!embProviderId"
              class="px-3 py-2 bg-theme-700 hover:bg-theme-600 disabled:bg-theme-800 disabled:text-theme-600 text-theme-300 text-sm rounded-lg transition-colors"
              title="Refresh embedding models"
              aria-label="Refresh embedding models"
              @click="embModelRefreshKey += 1"
            >
              <Icon
                icon="lucide:refresh-cw"
                class="w-4 h-4"
              />
            </button>
          </div>
        </div>
      </div>

      <div class="flex items-center justify-between gap-3">
        <SettingsPersistenceStatus
          mode="manual"
          :state="embStatus === 'error' ? 'error' : embSaving ? 'saving' : embDirty ? 'dirty' : embStatus"
        />
        <button
          :disabled="embSaving || embProbing || !embModel || !embDirty"
          class="ml-auto px-4 py-2 bg-accent-600 hover:bg-accent-500 disabled:bg-theme-700 disabled:text-theme-500 text-white text-sm rounded-lg transition-colors"
          @click="saveEmbeddings"
        >
          <span v-if="embSaving || embProbing">Saving...</span>
          <span v-else>Save changes</span>
        </button>
      </div>
    </BaseCard>

    <!-- Reranking -->
    <BaseCard
      v-if="showSection('reranker')"
      class="p-5 space-y-4"
    >
      <div class="flex items-center justify-between">
        <div class="flex items-start gap-3 min-w-0">
          <div class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center shrink-0">
            <Icon
              icon="lucide:list-filter"
              class="w-5 h-5 text-theme-400"
            />
          </div>
          <div>
            <h3 class="text-sm font-medium text-theme-200">
              Retrieval Reranker
            </h3>
            <p class="text-xs text-theme-500 mt-0.5">
              Optionally send the best hybrid-search candidates to an OpenRouter rerank model before memory is injected into chat context.
              This can improve relevance at the cost of one extra search request.
            </p>
          </div>
        </div>
        <ToggleSwitch
          v-model="rerankEnabled"
          label="Enable memory reranking"
          :disabled="rerankSaving"
          class="shrink-0 ml-4"
        />
      </div>

      <div class="space-y-3">
        <div>
          <label class="block text-xs text-theme-400 mb-1">OpenRouter Provider / Model</label>
          <ProviderModelSelect
            :provider-id="rerankProviderId"
            :model-value="rerankModel"
            :providers="openRouterProviders"
            model-type="reranker"
            placeholder="Select OpenRouter rerank model"
            dropdown-width="min-w-full"
            max-height="max-h-72"
            only-show-available-models
            @change="updateRerankerSelection"
          />
          <p
            v-if="openRouterProviders.length === 0"
            class="text-xs text-amber-400 mt-1"
          >
            Add an OpenRouter provider before enabling reranking.
          </p>
        </div>

        <div>
          <label class="block text-xs text-theme-400 mb-1">Candidate Pool</label>
          <input
            v-model.number="rerankCandidateCount"
            type="number"
            min="3"
            max="100"
            step="1"
            class="w-32 px-3 py-2 bg-theme-900 border border-theme-600 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
          >
          <p class="text-xs text-theme-500 mt-1">
            Candidates fetched before reranking. Larger pools can improve relevance but increase reranking cost.
          </p>
        </div>
      </div>

      <div class="flex items-center justify-between gap-3">
        <SettingsPersistenceStatus
          mode="manual"
          :state="rerankStatus === 'error' ? 'error' : rerankSaving ? 'saving' : rerankDirty ? 'dirty' : rerankStatus"
        />
        <button
          :disabled="rerankSaving || !rerankDirty || (rerankEnabled && (!rerankProviderId || !rerankModel))"
          class="ml-auto px-4 py-2 bg-accent-600 hover:bg-accent-500 disabled:bg-theme-700 disabled:text-theme-500 text-white text-sm rounded-lg transition-colors"
          @click="saveReranker"
        >
          <span v-if="rerankSaving">Saving...</span>
          <span v-else>Save changes</span>
        </button>
      </div>
    </BaseCard>

    <!-- Knowledge Extraction Model -->
    <BaseCard
      v-if="showSection('knowledge-extraction')"
      class="p-5 space-y-4"
    >
      <div class="flex items-start gap-3">
        <div class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center shrink-0">
          <Icon
            icon="lucide:network"
            class="w-5 h-5 text-theme-400"
          />
        </div>
        <div>
          <h3 class="text-sm font-medium text-theme-200">
            Knowledge Extraction Model
          </h3>
          <p class="text-xs text-theme-500 mt-0.5">
            Provider and model used when documents are analysed into facts for the local knowledge graph.
          </p>
        </div>
      </div>

      <div
        class="pt-1 border-t border-theme-700"
        :class="{ 'opacity-60': entityExtractionSaving }"
        :inert="entityExtractionSaving || undefined"
        :aria-busy="entityExtractionSaving"
      >
        <div class="flex items-center justify-between gap-3 mb-1.5">
          <label class="block text-xs text-theme-400">Provider / Model</label>
        </div>
        <ProviderModelSelect
          :provider-id="entityExtractionProviderId"
          :model-value="entityExtractionModel"
          :providers="providerStore.providers"
          include-default
          default-label="Use active provider default"
          placeholder="Use active provider default"
          @change="saveEntityExtractionSelection"
        />
        <p class="mt-2 text-[11px] leading-relaxed text-theme-500">
          This setting is used for explicit knowledge extraction. Leaving it on the default uses the server's active provider and that provider's default model.
        </p>
      </div>
      <div
        v-if="entityExtractionStatus === 'saving' || entityExtractionStatus === 'error'"
        class="flex justify-end"
      >
        <SettingsPersistenceStatus
          mode="auto"
          :state="entityExtractionStatus"
        />
      </div>
    </BaseCard>
    
    <SettingsSubheading
      v-if="showSection('chunking')"
      label="Document Processing"
    />

    <!-- Chunking -->
    <BaseCard
      v-if="showSection('chunking')"
      class="p-5 space-y-4"
    >
      <div class="flex items-start gap-3">
        <div class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center shrink-0">
          <Icon
            icon="lucide:scissors"
            class="w-5 h-5 text-theme-400"
          />
        </div>
        <div>
          <h3 class="text-sm font-medium text-theme-200">
            Chunking
          </h3>
          <p class="text-xs text-theme-500 mt-0.5">
            Controls how documents are split before embedding. Larger chunks retain more context,
            smaller chunks improve retrieval precision. Overlap ensures context isn't lost at chunk boundaries.
          </p>
        </div>
      </div>

      <div class="space-y-3">
        <div>
          <label class="block text-xs text-theme-400 mb-1">Chunk Size (tokens)</label>
          <input
            v-model.number="chunkSize"
            type="number"
            min="64"
            max="4096"
            step="64"
            class="w-40 px-3 py-2 bg-theme-900 border border-theme-600 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
          >
        </div>
        <div>
          <label class="block text-xs text-theme-400 mb-1">Chunk Overlap (tokens)</label>
          <input
            v-model.number="chunkOverlap"
            type="number"
            min="0"
            :max="chunkSize - 1"
            step="16"
            class="w-40 px-3 py-2 bg-theme-900 border border-theme-600 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
          >
        </div>
      </div>

      <div class="flex items-center justify-between gap-3">
        <SettingsPersistenceStatus
          mode="manual"
          :state="chunkStatus === 'error' ? 'error' : chunkSaving ? 'saving' : chunkDirty ? 'dirty' : chunkStatus"
        />
        <button
          :disabled="chunkSaving || !chunkDirty"
          class="ml-auto px-4 py-2 bg-accent-600 hover:bg-accent-500 disabled:bg-theme-700 disabled:text-theme-500 text-white text-sm rounded-lg transition-colors"
          @click="saveChunking"
        >
          <span v-if="chunkSaving">Saving...</span>
          <span v-else>Save changes</span>
        </button>
      </div>
    </BaseCard>

    <!-- Model change confirmation modal -->
    <ModalDialog
      :show="showDropConfirm"
      title="Embedding Model Changed"
      icon="lucide:alert-triangle"
      icon-color="amber"
      layer="nested"
      @close="cancelDrop"
    >
      <p class="text-theme-400 leading-relaxed">
        Changing the embedding provider or model makes existing vectors incompatible.
        You can <strong class="text-theme-200">re-embed</strong> all stored memories with the new model to preserve your data,
        or <strong class="text-theme-200">drop</strong> all vectors and re-upload files manually.
      </p>

      <!-- Re-embed progress bar -->
      <div
        v-if="reembedProgress"
        class="mt-4 space-y-2"
      >
        <div class="flex items-center justify-between text-xs text-theme-400">
          <span>Re-embedding...</span>
          <span>{{ reembedProgress.current }} / {{ reembedProgress.total }} chunks ({{ reembedPercent }}%)</span>
        </div>
        <div class="w-full h-2 bg-theme-700 rounded-full overflow-hidden">
          <div
            class="h-full bg-accent-500 rounded-full transition-all duration-300"
            :style="{ width: `${reembedPercent}%` }"
          />
        </div>
      </div>

      <template #actions>
        <button
          :disabled="embSaving"
          class="w-full px-4 py-3 bg-accent-600 hover:bg-accent-500 disabled:bg-theme-700 text-white rounded-xl text-center font-medium transition-colors"
          @click="confirmReembed"
        >
          {{ embSaving ? 'Re-Embedding...' : 'Re-Embed All Memories' }}
        </button>
        <button
          :disabled="embSaving"
          class="w-full px-4 py-3 bg-amber-600 hover:bg-amber-500 disabled:bg-theme-700 text-white rounded-xl text-center font-medium transition-colors"
          @click="confirmDrop"
        >
          {{ embSaving ? 'Saving...' : 'Drop & Save' }}
        </button>
        <button
          :disabled="embSaving"
          class="w-full px-4 py-3 bg-theme-800 hover:bg-theme-700 text-theme-300 rounded-xl text-center font-medium transition-colors"
          @click="cancelDrop"
        >
          Cancel
        </button>
      </template>
    </ModalDialog>
  </div>
</template>
