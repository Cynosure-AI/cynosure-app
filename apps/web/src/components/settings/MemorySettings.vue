<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useProviderStore } from '../../stores/provider.store'
import { usePreferencesStore } from '../../stores/preferences.store'
import { api } from '../../api/client'
import { Icon } from '@iconify/vue'
import ModalDialog from '../shared/ModalDialog.vue'
import MultiSelect from '../shared/MultiSelect.vue'
import ProviderSelect from '../shared/ProviderSelect.vue'
import ProviderModelSelect from '../shared/ProviderModelSelect.vue'
import CustomSelect from '../shared/CustomSelect.vue'
import BaseCard from '../shared/BaseCard.vue'
import ToggleSwitch from '../shared/ToggleSwitch.vue'
import SettingsSubheading from './SettingsSubheading.vue'
import {
  defaultEmbeddingModelForProviderId,
  withDefaultEmbeddingModel,
} from '../../utils/embedding-defaults'

const providerStore = useProviderStore()
const prefs = usePreferencesStore()
const props = withDefaults(defineProps<{
  visibleSections?: string[]
}>(), {
  visibleSections: () => []
})

function showSection(id: string): boolean {
  return props.visibleSections.length === 0 || props.visibleSections.includes(id)
}

function showAnySection(ids: string[]): boolean {
  return ids.some(showSection)
}

// Embedding state
const embProviderId = ref('')
const embModel = ref('')
const embDimensions = ref(1536)
const embModels = ref<string[]>([])
const embLoadingModels = ref(false)

const embSaving = ref(false)
const embDirty = ref(false)
const embProbing = ref(false)
const loadingEmbeddingConfig = ref(true)

// Chunking state
const chunkSize = ref(512)
const chunkOverlap = ref(64)
const chunkSaving = ref(false)

// Document parser state
const ocrEnabled = ref(false)
const ocrLanguage = ref('eng')
const ocrSaving = ref(false)

// Reranker state
const rerankEnabled = ref(false)
const rerankProviderId = ref('')
const rerankModel = ref('cohere/rerank-4-fast')
const rerankCandidateCount = ref(12)
const rerankSaving = ref(false)

// Entity extraction state
const entityExtractionProviderId = ref('')
const entityExtractionModel = ref('')
const entityExtractionSaving = ref(false)

const RERANK_MODEL_OPTIONS = [
  { value: 'cohere/rerank-4-fast', label: 'Cohere Rerank 4 Fast', hint: 'cohere/rerank-4-fast' },
  { value: 'cohere/rerank-4-pro', label: 'Cohere Rerank 4 Pro', hint: 'cohere/rerank-4-pro' },
  { value: 'cohere/rerank-v3.5', label: 'Cohere Rerank v3.5', hint: 'cohere/rerank-v3.5' },
]

const OCR_LANGUAGE_OPTIONS = [
  { value: 'eng', label: 'English', hint: 'eng' },
  { value: 'deu', label: 'German', hint: 'deu' },
  { value: 'fra', label: 'French', hint: 'fra' },
  { value: 'spa', label: 'Spanish', hint: 'spa' },
  { value: 'ita', label: 'Italian', hint: 'ita' },
  { value: 'por', label: 'Portuguese', hint: 'por' },
  { value: 'nld', label: 'Dutch', hint: 'nld' },
  { value: 'pol', label: 'Polish', hint: 'pol' },
  { value: 'rus', label: 'Russian', hint: 'rus' },
  { value: 'jpn', label: 'Japanese', hint: 'jpn' },
  { value: 'kor', label: 'Korean', hint: 'kor' },
  { value: 'chi_sim', label: 'Chinese (Simplified)', hint: 'chi_sim' },
  { value: 'chi_tra', label: 'Chinese (Traditional)', hint: 'chi_tra' },
  { value: 'ara', label: 'Arabic', hint: 'ara' },
  { value: 'hin', label: 'Hindi', hint: 'hin' },
  { value: 'tur', label: 'Turkish', hint: 'tur' },
  { value: 'swe', label: 'Swedish', hint: 'swe' },
  { value: 'nor', label: 'Norwegian', hint: 'nor' },
  { value: 'dan', label: 'Danish', hint: 'dan' },
  { value: 'fin', label: 'Finnish', hint: 'fin' },
  { value: 'ces', label: 'Czech', hint: 'ces' },
  { value: 'ron', label: 'Romanian', hint: 'ron' },
  { value: 'hun', label: 'Hungarian', hint: 'hun' },
  { value: 'ukr', label: 'Ukrainian', hint: 'ukr' },
  { value: 'tha', label: 'Thai', hint: 'tha' },
  { value: 'vie', label: 'Vietnamese', hint: 'vie' },
]

const selectedOcrLangs = computed({
  get: () => ocrLanguage.value.split('+').filter(Boolean),
  set: (val: string[]) => { ocrLanguage.value = val.join('+') },
})

async function onOcrLangsUpdate(langs: string[]) {
  selectedOcrLangs.value = langs
  await saveOcrLanguage()
}

const embModelGroups = computed(() => [
  {
    options: embModels.value.map((m) => ({
      value: m,
      label: m,
    })),
  },
])

const rerankModelGroups = computed(() => [
  {
    options: RERANK_MODEL_OPTIONS.map((m) => ({
      value: m.value,
      label: m.label,
      tag: m.hint,
    })),
  },
])

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

// Manual clear
const showManualClear = ref(false)
const clearingDb = ref(false)
const showGraphClear = ref(false)
const clearingGraph = ref(false)

onMounted(async () => {
  await providerStore.loadProviders()
  await loadEmbeddingConfig()
  await loadEntityExtractionConfig()
  await loadChunkingConfig()
  await loadParserConfig()
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
      await fetchEmbModels(embProviderId.value)
    } else {
      applyDefaultEmbeddingConfig()
    }
    embDirty.value = false
  } catch {
    applyDefaultEmbeddingConfig()
    embDirty.value = false
  }
  loadingEmbeddingConfig.value = false
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

async function loadParserConfig() {
  try {
    const config = await api.memory.getParserConfig()
    ocrEnabled.value = config.ocrEnabled
    ocrLanguage.value = config.ocrLanguage || 'eng'
  } catch { /* defaults */ }
}

async function loadRerankerConfig() {
  try {
    const config = await api.memory.getRerankerConfig()
    rerankEnabled.value = config.enabled
    rerankProviderId.value = config.providerId || openRouterProviders.value[0]?.id || ''
    rerankModel.value = config.model
    rerankCandidateCount.value = config.candidateCount
  } catch {
    rerankProviderId.value = openRouterProviders.value[0]?.id || ''
  }
}

async function loadEntityExtractionConfig() {
  try {
    const config = await api.memory.getEntityExtractionConfig()
    entityExtractionProviderId.value = config.providerId || ''
    entityExtractionModel.value = config.model || ''

    if (!entityExtractionProviderId.value && !entityExtractionModel.value && (prefs.entityGraphProviderId || prefs.entityGraphModel)) {
      await saveEntityExtractionSelection({
        providerId: prefs.entityGraphProviderId,
        model: prefs.entityGraphModel,
      })
    }
  } catch {
    entityExtractionProviderId.value = prefs.entityGraphProviderId || ''
    entityExtractionModel.value = prefs.entityGraphModel || ''
  }
}

async function saveEntityExtractionSelection(selection: { providerId: string; model: string }) {
  entityExtractionProviderId.value = selection.providerId
  entityExtractionModel.value = selection.model
  prefs.entityGraphProviderId = selection.providerId
  prefs.entityGraphModel = selection.model
  entityExtractionSaving.value = true
  try {
    const res = await api.memory.configureEntityExtraction({
      providerId: selection.providerId || undefined,
      model: selection.model || undefined,
    })
    entityExtractionProviderId.value = res.providerId || ''
    entityExtractionModel.value = res.model || ''
  } catch { /* error handling */ }
  entityExtractionSaving.value = false
}

async function toggleOcr() {
  ocrSaving.value = true
  try {
    const res = await api.memory.configureParser({ ocrEnabled: !ocrEnabled.value, ocrLanguage: ocrLanguage.value })
    ocrEnabled.value = res.ocrEnabled
  } catch { /* error handling */ }
  ocrSaving.value = false
}

async function saveOcrLanguage() {
  ocrSaving.value = true
  try {
    await api.memory.configureParser({ ocrEnabled: ocrEnabled.value, ocrLanguage: ocrLanguage.value.trim() || 'eng' })
  } catch { /* error handling */ }
  ocrSaving.value = false
}

async function saveReranker() {
  rerankSaving.value = true
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
  } catch { /* error handling */ }
  rerankSaving.value = false
}

async function fetchEmbModels(providerId: string) {
  if (!providerId) { embModels.value = []; return }
  embLoadingModels.value = true
  const defaultModel = defaultEmbeddingModelForProviderId(providerId, providerStore.providers)
  try {
    const models = await providerStore.listModels(providerId, 'embedding')
    embModels.value = withDefaultEmbeddingModel(models, defaultModel)
  } catch { embModels.value = withDefaultEmbeddingModel([], defaultModel) }
  embLoadingModels.value = false
}

watch(embProviderId, (id) => {
  if (loadingEmbeddingConfig.value) return
  embDirty.value = true
  const defaultModel = defaultEmbeddingModelForProviderId(id, providerStore.providers)
  if (defaultModel) embModel.value = defaultModel
  fetchEmbModels(id)
})
watch(embModel, () => { embDirty.value = true })

function applyDefaultEmbeddingConfig() {
  const providerId = providerStore.lastUsedProviderId || providerStore.providers[0]?.id || ''
  const defaultModel = defaultEmbeddingModelForProviderId(providerId, providerStore.providers)
  if (!providerId || !defaultModel) return
  embProviderId.value = providerId
  embModel.value = defaultModel
  embDimensions.value = 0
  fetchEmbModels(providerId)
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
  try {
    const res = await api.memory.configureEmbeddings({
      providerId: embProviderId.value || undefined,
      model: embModel.value,
      reembed
    })
    embDimensions.value = res.dimensions
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

async function manualClearGraph() {
  clearingGraph.value = true
  try {
    await api.memory.clearGraph()
  } catch { /* error handling */ }
  clearingGraph.value = false
  showGraphClear.value = false
}

</script>

<template>
  <div class="space-y-4">
    <SettingsSubheading
      v-if="showAnySection(['embedding-model', 'entity-graph-extraction', 'reranker'])"
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
            <CustomSelect
              v-model="embModel"
              :groups="embModelGroups"
              placeholder="Select or type model name..."
              filterable
              dropdown-width="min-w-full"
              class="flex-1"
            />
            <button
              :disabled="embLoadingModels || !embProviderId"
              class="px-3 py-2 bg-theme-700 hover:bg-theme-600 disabled:bg-theme-800 disabled:text-theme-600 text-theme-300 text-sm rounded-lg transition-colors"
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
      </div>

      <button
        :disabled="embSaving || embProbing || !embModel"
        class="px-4 py-2 bg-accent-600 hover:bg-accent-500 disabled:bg-theme-700 disabled:text-theme-500 text-white text-sm rounded-lg transition-colors"
        @click="saveEmbeddings"
      >
        <span v-if="embSaving || embProbing">Saving...</span>
        <span v-else>Save Embedding Config</span>
      </button>
    </BaseCard>

    <!-- Entity Extraction Model -->
    <BaseCard
      v-if="showSection('entity-graph-extraction')"
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
            Entity Extraction Model
          </h3>
          <p class="text-xs text-theme-500 mt-0.5">
            Provider and model used when explicit document entity indexing extracts entities and relationships for the local entity graph.
          </p>
        </div>
      </div>

      <div class="pt-1 border-t border-theme-700">
        <div class="flex items-center justify-between gap-3 mb-1.5">
          <label class="block text-xs text-theme-400">Provider / Model</label>
          <span
            v-if="entityExtractionSaving"
            class="text-[11px] text-theme-500"
          >
            Saving...
          </span>
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
          This setting is used for explicit entity extraction calls. Leaving it on the default uses the server's active provider and that provider's default model.
        </p>
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
          :disabled="rerankSaving"
          class="shrink-0 ml-4"
        />
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="block text-xs text-theme-400 mb-1">OpenRouter Provider</label>
          <ProviderSelect
            v-model="rerankProviderId"
            :providers="openRouterProviders"
            placeholder="Select OpenRouter provider"
          />
          <p
            v-if="openRouterProviders.length === 0"
            class="text-xs text-amber-400 mt-1"
          >
            Add an OpenRouter provider before enabling reranking.
          </p>
        </div>

        <div>
          <label class="block text-xs text-theme-400 mb-1">Model</label>
          <CustomSelect
            v-model="rerankModel"
            :groups="rerankModelGroups"
            placeholder="Select rerank model"
            dropdown-width="min-w-full"
          />
        </div>

        <div>
          <label class="block text-xs text-theme-400 mb-1">Candidate Pool</label>
          <input
            v-model.number="rerankCandidateCount"
            type="number"
            min="3"
            max="50"
            step="1"
            class="w-32 px-3 py-2 bg-theme-900 border border-theme-600 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
          >
          <p class="text-xs text-theme-500 mt-1">
            More candidates can improve recall but increase rerank latency.
          </p>
        </div>
      </div>

      <button
        :disabled="rerankSaving || (rerankEnabled && !rerankProviderId)"
        class="px-4 py-2 bg-accent-600 hover:bg-accent-500 disabled:bg-theme-700 disabled:text-theme-500 text-white text-sm rounded-lg transition-colors"
        @click="saveReranker"
      >
        <span v-if="rerankSaving">Saving...</span>
        <span v-else>Save Reranker Config</span>
      </button>
    </BaseCard>

    <SettingsSubheading
      v-if="showAnySection(['chunking', 'ocr'])"
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

      <button
        :disabled="chunkSaving"
        class="px-4 py-2 bg-accent-600 hover:bg-accent-500 disabled:bg-theme-700 disabled:text-theme-500 text-white text-sm rounded-lg transition-colors"
        @click="saveChunking"
      >
        <span v-if="chunkSaving">Saving...</span>
        <span v-else>Save Chunking Config</span>
      </button>
    </BaseCard>

    <!-- Document Parsing – OCR -->
    <BaseCard
      v-if="showSection('ocr')"
      class="p-5 space-y-4"
    >
      <div class="flex items-center justify-between">
        <div class="flex items-start gap-3 min-w-0">
          <div class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center shrink-0">
            <Icon
              icon="lucide:scan-text"
              class="w-5 h-5 text-theme-400"
            />
          </div>
          <div>
            <h3 class="text-sm font-medium text-theme-200">
              OCR for Document Images
            </h3>
            <p class="text-xs text-theme-500 mt-0.5">
              When enabled, images embedded in uploaded documents (PDFs, DOCX, PPTX, etc.) will be
              processed with OCR to extract visible text. Useful for scanned documents and presentations with text inside images.
            </p>
          </div>
        </div>
        <ToggleSwitch
          :model-value="ocrEnabled"
          :disabled="ocrSaving"
          class="shrink-0 ml-4"
          @update:model-value="toggleOcr"
        />
      </div>

      <!-- OCR Language Multi-select -->
      <div v-if="ocrEnabled">
        <label class="text-xs text-theme-400 mb-1 block">OCR Language(s)</label>
        <MultiSelect
          :model-value="selectedOcrLangs"
          :options="OCR_LANGUAGE_OPTIONS"
          :min-selected="1"
          placeholder="Select languages..."
          @update:model-value="onOcrLangsUpdate"
        />
      </div>
    </BaseCard>

    <SettingsSubheading
      v-if="showAnySection(['vector-database'])"
      label="Maintenance"
    />

    <!-- Danger Zone -->
    <div
      v-if="showSection('vector-database')"
      class="rounded-xl border border-red-900/50 bg-theme-800 p-5 space-y-4"
    >
      <div class="flex items-start gap-3">
        <div class="w-9 h-9 rounded-lg bg-red-950/60 flex items-center justify-center shrink-0">
          <Icon
            icon="lucide:trash-2"
            class="w-5 h-5 text-red-400"
          />
        </div>
        <div>
          <h3 class="text-sm font-medium text-theme-200">
            Memory Data
          </h3>
          <p class="text-xs text-theme-500 mt-0.5">
            Clear derived memory indexes. These actions do not delete chat messages, agents, or provider settings.
          </p>
        </div>
      </div>
      <div class="space-y-3">
        <div class="rounded-lg border border-red-900/40 bg-red-950/20 p-3">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div class="text-sm font-medium text-theme-200">
                Entity Graph
              </div>
              <p class="text-xs text-theme-500 mt-0.5">
                Delete all extracted entities and relationships. Vector memories and files are left untouched.
              </p>
            </div>
            <button
              class="px-4 py-2 bg-red-600/80 hover:bg-red-500 text-white text-sm rounded-lg transition-colors shrink-0"
              @click="showGraphClear = true"
            >
              Clear Entity Graph
            </button>
          </div>
        </div>

        <div class="rounded-lg border border-red-900/40 bg-red-950/20 p-3">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div class="text-sm font-medium text-theme-200">
                Vector Database
              </div>
              <p class="text-xs text-theme-500 mt-0.5">
                Clear all stored vector embeddings. You will need to re-upload or re-index knowledge files afterwards.
              </p>
            </div>
            <button
              class="px-4 py-2 bg-red-600/80 hover:bg-red-500 text-white text-sm rounded-lg transition-colors shrink-0"
              @click="showManualClear = true"
            >
              Clear Vector Database
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Model change confirmation modal -->
    <ModalDialog
      :show="showDropConfirm"
      title="Embedding Model Changed"
      icon="lucide:alert-triangle"
      icon-color="amber"
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

    <ModalDialog
      :show="showGraphClear"
      title="Clear Entity Graph"
      icon="lucide:network"
      icon-color="red"
      @close="showGraphClear = false"
    >
      <p class="text-theme-400 leading-relaxed">
        This will permanently delete all extracted entities and relationships. Your memory files and vector embeddings will remain in place.
      </p>
      <template #actions>
        <button
          :disabled="clearingGraph"
          class="w-full px-4 py-3 bg-red-600 hover:bg-red-500 disabled:bg-theme-700 text-white rounded-xl text-center font-medium transition-colors"
          @click="manualClearGraph"
        >
          {{ clearingGraph ? 'Clearing...' : 'Clear Entity Graph' }}
        </button>
        <button
          class="w-full px-4 py-3 bg-theme-800 hover:bg-theme-700 text-theme-300 rounded-xl text-center font-medium transition-colors"
          @click="showGraphClear = false"
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
      <p class="text-theme-400 leading-relaxed">
        This will permanently delete all stored vector embeddings and memories across all agents. You will need to re-upload any knowledge files afterwards.
      </p>
      <template #actions>
        <button
          :disabled="clearingDb"
          class="w-full px-4 py-3 bg-red-600 hover:bg-red-500 disabled:bg-theme-700 text-white rounded-xl text-center font-medium transition-colors"
          @click="manualClearDb"
        >
          {{ clearingDb ? 'Clearing...' : 'Clear All Vectors' }}
        </button>
        <button
          class="w-full px-4 py-3 bg-theme-800 hover:bg-theme-700 text-theme-300 rounded-xl text-center font-medium transition-colors"
          @click="showManualClear = false"
        >
          Cancel
        </button>
      </template>
    </ModalDialog>
  </div>
</template>
