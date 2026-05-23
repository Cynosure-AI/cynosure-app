<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useProviderStore } from '../../stores/provider.store'
import { api } from '../../api/client'
import { Icon } from '@iconify/vue'
import ModalDialog from '../shared/ModalDialog.vue'
import MultiSelect from '../shared/MultiSelect.vue'
import ProviderSelect from '../shared/ProviderSelect.vue'
import CustomSelect from '../shared/CustomSelect.vue'
import BaseCard from '../shared/BaseCard.vue'
import ToggleSwitch from '../shared/ToggleSwitch.vue'

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

const RERANK_MODEL_OPTIONS = [
  { value: 'cohere/rerank-4-fast', label: 'Cohere Rerank 4 Fast', hint: 'cohere/rerank-4-fast' },
  { value: 'cohere/rerank-4-pro', label: 'Cohere Rerank 4 Pro', hint: 'cohere/rerank-4-pro' },
  { value: 'cohere/rerank-v3.5', label: 'Cohere Rerank v3.5', hint: 'cohere/rerank-v3.5' },
]

const MEMORY_CREATE_TOOL = 'memory_create'
const MEMORY_UPDATE_TOOL = 'memory_update'

const memoryCreateAutoApprove = ref(false)
const memoryUpdateAutoApprove = ref(false)
const memoryPermissionSaving = ref<string | null>(null)

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

onMounted(async () => {
  await providerStore.loadProviders()
  await loadMemoryToolApprovals()
  await loadEmbeddingConfig()
  await loadChunkingConfig()
  await loadParserConfig()
  await loadRerankerConfig()
})

async function loadMemoryToolApprovals() {
  try {
    const approvals = await api.agent.getToolApprovals()
    memoryCreateAutoApprove.value = approvals[MEMORY_CREATE_TOOL] === true
    memoryUpdateAutoApprove.value = approvals[MEMORY_UPDATE_TOOL] === true
  } catch { /* defaults */ }
}

async function setMemoryToolApproval(toolName: string, autoApprove: boolean) {
  memoryPermissionSaving.value = toolName
  try {
    await api.agent.setToolApproval(toolName, autoApprove)
    if (toolName === MEMORY_CREATE_TOOL) memoryCreateAutoApprove.value = autoApprove
    if (toolName === MEMORY_UPDATE_TOOL) memoryUpdateAutoApprove.value = autoApprove
  } catch { /* keep previous value */ }
  memoryPermissionSaving.value = null
}

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
    <!-- Memory Write Permissions -->
    <BaseCard class="p-5 space-y-4 mb-4">
      <div>
        <h3 class="text-sm font-medium text-theme-200 mb-1">
          Memory Write Permissions
        </h3>
        <p class="text-xs text-theme-500">
          Read-only memory tools are always allowed. Creating or updating memories asks for approval unless enabled here, approved for the session, or allowed by the active agent.
        </p>
      </div>

      <div class="space-y-2">
        <div class="flex items-start justify-between gap-4 rounded-lg border border-theme-700 bg-theme-900/40 p-3">
          <div class="flex items-start gap-3 min-w-0">
            <div class="w-7 h-7 rounded-lg bg-theme-800 flex items-center justify-center shrink-0">
              <Icon
                icon="lucide:file-plus-2"
                class="w-3.5 h-3.5 text-accent-400"
              />
            </div>
            <div class="min-w-0">
              <div class="text-sm text-theme-200">
                Allow memory creation
              </div>
              <div class="text-[11px] text-theme-500 leading-relaxed">
                Auto-approve persistent writes from the memory_create tool.
              </div>
            </div>
          </div>
          <ToggleSwitch
            :model-value="memoryCreateAutoApprove"
            :disabled="memoryPermissionSaving === MEMORY_CREATE_TOOL"
            class="mt-0.5 shrink-0"
            @update:model-value="setMemoryToolApproval(MEMORY_CREATE_TOOL, $event)"
          />
        </div>

        <div class="flex items-start justify-between gap-4 rounded-lg border border-theme-700 bg-theme-900/40 p-3">
          <div class="flex items-start gap-3 min-w-0">
            <div class="w-7 h-7 rounded-lg bg-theme-800 flex items-center justify-center shrink-0">
              <Icon
                icon="lucide:file-pen-line"
                class="w-3.5 h-3.5 text-accent-400"
              />
            </div>
            <div class="min-w-0">
              <div class="text-sm text-theme-200">
                Allow memory updates
              </div>
              <div class="text-[11px] text-theme-500 leading-relaxed">
                Auto-approve persistent edits from the memory_update tool.
              </div>
            </div>
          </div>
          <ToggleSwitch
            :model-value="memoryUpdateAutoApprove"
            :disabled="memoryPermissionSaving === MEMORY_UPDATE_TOOL"
            class="mt-0.5 shrink-0"
            @update:model-value="setMemoryToolApproval(MEMORY_UPDATE_TOOL, $event)"
          />
        </div>
      </div>
    </BaseCard>

    <!-- Embedding Model -->
    <BaseCard class="p-5 space-y-4 mb-4">
      <div>
        <h3 class="text-sm font-medium text-theme-200 mb-1">
          Embedding Model
        </h3>
        <p class="text-xs text-theme-500">
          Select which provider and model to use for generating vector embeddings.
          Changing the model will offer to re-embed existing memories or drop them.
        </p>
        <p class="text-xs text-theme-500 mt-1">
          For local embeddings we recommend <span class="text-theme-300 font-medium">mxbai-embed-large</span> for
          best retrieval quality.
        </p>
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
          <label class="block text-xs text-theme-400 mb-1">Model</label>
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

        <div>
          <label class="block text-xs text-theme-400 mb-1">Dimensions</label>
          <div class="flex gap-2 items-center">
            <input
              v-model.number="embDimensions"
              type="number"
              min="64"
              max="8192"
              class="w-32 px-3 py-2 bg-theme-900 border border-theme-600 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
            >
            <button
              :disabled="embProbing || !embModel"
              class="px-3 py-2 bg-theme-700 hover:bg-theme-600 disabled:bg-theme-800 disabled:text-theme-600 text-theme-300 text-xs rounded-lg transition-colors flex items-center gap-1.5"
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
        class="px-4 py-2 bg-accent-600 hover:bg-accent-500 disabled:bg-theme-700 disabled:text-theme-500 text-white text-sm rounded-lg transition-colors"
        @click="saveEmbeddings"
      >
        <span v-if="embSaving">Saving...</span>
        <span v-else>Save Embedding Config</span>
      </button>
    </BaseCard>

    <!-- Reranking -->
    <BaseCard class="p-5 space-y-4 mb-4">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h3 class="text-sm font-medium text-theme-200 mb-1">
            Retrieval Reranker
          </h3>
          <p class="text-xs text-theme-500">
            Optionally send the best hybrid-search candidates to an OpenRouter rerank model before memory is injected into chat context.
            This can improve relevance at the cost of one extra search request.
          </p>
        </div>
        <ToggleSwitch
          v-model="rerankEnabled"
          :disabled="rerankSaving"
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

    <!-- Chunking -->
    <BaseCard class="p-5 space-y-4 mb-4">
      <div>
        <h3 class="text-sm font-medium text-theme-200 mb-1">
          Chunking
        </h3>
        <p class="text-xs text-theme-500">
          Controls how documents are split before embedding. Larger chunks retain more context,
          smaller chunks improve retrieval precision. Overlap ensures context isn't lost at chunk boundaries.
          Sections and headings are also taken into account to avoid splitting in the middle of important content.
        </p>
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
    <BaseCard class="p-5 space-y-4 mb-4">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h3 class="text-sm font-medium text-theme-200 mb-1">
            OCR for Document Images
          </h3>
          <p class="text-xs text-theme-500">
            When enabled, images embedded in uploaded documents (PDFs, DOCX, PPTX, etc.) will be
            processed with OCR to extract visible text. Useful for scanned documents, diagrams with
            labels, or presentations with text inside images. Increases processing time.
          </p>
        </div>
        <button
          :disabled="ocrSaving"
          class="shrink-0 mt-0.5 relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none"
          :class="ocrEnabled ? 'bg-accent-600' : 'bg-theme-600'"
          @click="toggleOcr"
        >
          <span
            class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
            :class="ocrEnabled ? 'translate-x-6' : 'translate-x-1'"
          />
        </button>
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

    <!-- Danger Zone -->
    <div class="rounded-xl mt-4 border border-red-900/50 bg-theme-800 p-5 space-y-3">
      <div>
        <h3 class="text-sm font-medium text-theme-200 mb-1">
          Danger Zone
        </h3>
        <p class="text-xs text-theme-500">
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
      <p class="text-theme-400 leading-relaxed">
        Changing the embedding model or dimensions makes existing vectors incompatible.
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
