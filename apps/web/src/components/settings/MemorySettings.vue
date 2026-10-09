<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useProviderStore } from '../../stores/provider.store'
import { api } from '../../api/client'
import { Icon } from '@iconify/vue'
import ModalDialog from '../shared/ModalDialog.vue'
import ProviderModelSelect from '../shared/ProviderModelSelect.vue'
import BaseCard from '../shared/BaseCard.vue'
import ToggleSwitch from '../shared/ToggleSwitch.vue'
import SettingsSubheading from './SettingsSubheading.vue'
import SettingsPersistenceStatus, { type SettingsPersistenceState } from './SettingsPersistenceStatus.vue'
import {
  defaultEmbeddingModelForProviderId,
} from '../../utils/embedding-defaults'
import { isLocalProvider } from '../../utils/provider-defaults'

const providerStore = useProviderStore()
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
const savedDream = ref({ enabled: false, providerId: '', model: '' })
const dreamStatus = ref<SettingsPersistenceState>('idle')

async function loadDreamConfig() {
  try {
    const config = await api.memory.getDreamConfig()
    dreamEnabled.value = config.enabled
    dreamProviderId.value = config.providerId
    dreamModel.value = config.model
    savedDream.value = { enabled: config.enabled, providerId: config.providerId, model: config.model }
    dreamLoaded.value = true
  } catch (error) {
    dreamError.value = error instanceof Error ? error.message : 'Could not load Dream settings.'
  }
}
async function saveDream() {
  dreamSaving.value = true
  dreamStatus.value = 'saving'
  dreamError.value = ''
  try {
    const config = await api.memory.configureDream({ enabled: dreamEnabled.value, providerId: dreamProviderId.value, model: dreamModel.value })
    dreamEnabled.value = config.enabled
    dreamProviderId.value = config.providerId
    dreamModel.value = config.model
    savedDream.value = { enabled: config.enabled, providerId: config.providerId, model: config.model }
    dreamStatus.value = 'saved'
  } catch (error) {
    dreamError.value = error instanceof Error ? error.message : 'Could not save Dream settings.'
    dreamStatus.value = 'error'
  } finally {
    dreamSaving.value = false
  }
}

// Embedding state
const embProviderId = ref('')
const embModel = ref('')
// Known only once a model is configured or probed; 0 hides the label.
const embDimensions = ref(0)
const embModelRefreshKey = ref(0)

const embSaving = ref(false)
const savedEmbedding = ref({ providerId: '', model: '', dimensions: 0 })
const embStatus = ref<SettingsPersistenceState>('idle')
const embError = ref('')
const embProbing = ref(false)
const loadingEmbeddingConfig = ref(true)

// Reranker state
const rerankEnabled = ref(false)
const rerankProviderId = ref('')
const rerankModel = ref('')
// Curation model used instead of the reranker when reranking is off; empty = conversation model
const curationProviderId = ref('')
const curationModel = ref('')
const rerankSaving = ref(false)
const savedReranker = ref({
  enabled: false,
  providerId: '',
  model: '',
  curationProviderId: '',
  curationModel: '',
})
const rerankStatus = ref<SettingsPersistenceState>('idle')

const embDirty = computed(() =>
  embProviderId.value !== savedEmbedding.value.providerId || embModel.value !== savedEmbedding.value.model
)
const rerankDirty = computed(() =>
  rerankEnabled.value !== savedReranker.value.enabled ||
  rerankProviderId.value !== savedReranker.value.providerId ||
  rerankModel.value !== savedReranker.value.model ||
  curationProviderId.value !== savedReranker.value.curationProviderId ||
  curationModel.value !== savedReranker.value.curationModel
)
const dreamDirty = computed(() => dreamLoaded.value && (
  dreamEnabled.value !== savedDream.value.enabled ||
  dreamProviderId.value !== savedDream.value.providerId ||
  dreamModel.value !== savedDream.value.model
))
const dreamSelectionValid = computed(() => {
  if (!dreamProviderId.value) return false
  if (dreamModel.value) return true
  return Boolean(providerStore.providers.find(provider => provider.id === dreamProviderId.value)?.defaultModel)
})
const manualDirty = computed(() => embDirty.value || rerankDirty.value || dreamDirty.value)

watch(manualDirty, (dirty) => emit('dirty-change', dirty), { immediate: true })

const hasLocalProvider = computed(() =>
  providerStore.providers.some((provider) => isLocalProvider(provider.type))
)

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
  await loadRerankerConfig()
})

async function loadEmbeddingConfig() {
  loadingEmbeddingConfig.value = true
  let persisted = false
  try {
    const config = await api.memory.getEmbeddingConfig()
    if (config.providerId) {
      embProviderId.value = config.providerId
      embModel.value = config.model
      embDimensions.value = config.dimensions
      persisted = true
    } else {
      applyDefaultEmbeddingConfig()
    }
  } catch {
    applyDefaultEmbeddingConfig()
  }
  savedEmbedding.value = persisted
    ? { providerId: embProviderId.value, model: embModel.value, dimensions: embDimensions.value }
    : { providerId: '', model: '', dimensions: 0 }
  loadingEmbeddingConfig.value = false
}

async function loadRerankerConfig() {
  try {
    const config = await api.memory.getRerankerConfig()
    rerankEnabled.value = config.enabled
    rerankProviderId.value = config.providerId || openRouterProviders.value[0]?.id || ''
    rerankModel.value = config.model
    curationProviderId.value = config.curationProviderId || ''
    curationModel.value = config.curationModel || ''
    savedReranker.value = {
      enabled: config.enabled,
      providerId: config.providerId || rerankProviderId.value,
      model: config.model,
      curationProviderId: curationProviderId.value,
      curationModel: curationModel.value,
    }
  } catch {
    rerankProviderId.value = openRouterProviders.value[0]?.id || ''
    savedReranker.value = {
      enabled: rerankEnabled.value,
      providerId: rerankProviderId.value,
      model: rerankModel.value,
      curationProviderId: curationProviderId.value,
      curationModel: curationModel.value,
    }
  }
}

async function saveReranker() {
  rerankSaving.value = true
  rerankStatus.value = 'saving'
  try {
    const res = await api.memory.configureReranker({
      enabled: rerankEnabled.value,
      providerId: rerankProviderId.value || undefined,
      model: rerankModel.value,
      curationProviderId: curationProviderId.value || undefined,
      curationModel: curationModel.value,
    })
    rerankEnabled.value = res.enabled
    rerankProviderId.value = res.providerId || rerankProviderId.value
    rerankModel.value = res.model
    curationProviderId.value = res.curationProviderId || ''
    curationModel.value = res.curationModel || ''
    savedReranker.value = {
      enabled: res.enabled,
      providerId: res.providerId || rerankProviderId.value,
      model: res.model,
      curationProviderId: curationProviderId.value,
      curationModel: curationModel.value,
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

function updateCurationSelection(selection: { providerId: string; model: string }) {
  curationProviderId.value = selection.providerId
  curationModel.value = selection.model
}

function updateEmbeddingSelection(selection: { providerId: string; model: string }) {
  embProviderId.value = selection.providerId
  embModel.value = selection.model
  embDimensions.value = selection.providerId === savedEmbedding.value.providerId && selection.model === savedEmbedding.value.model
    ? savedEmbedding.value.dimensions
    : 0
}

function applyDefaultEmbeddingConfig() {
  const providerId = providerStore.lastUsedProviderId || providerStore.providers[0]?.id || ''
  const defaultModel = defaultEmbeddingModelForProviderId(providerId, providerStore.providers)
  if (!providerId || !defaultModel) return
  embProviderId.value = providerId
  embModel.value = defaultModel
  embDimensions.value = 0
}

/** Ask the model for its vector size. Returns false when the model could not be reached. */
async function probeDimensions(): Promise<boolean> {
  if (!embModel.value) return false
  embProbing.value = true
  try {
    const res = await api.memory.probeEmbedding({
      providerId: embProviderId.value || undefined,
      model: embModel.value
    })
    embDimensions.value = res.dimensions
    return true
  } catch (error) {
    embError.value = `The embedding model did not respond: ${error instanceof Error ? error.message : 'unknown error'}`
    embStatus.value = 'error'
    return false
  } finally {
    embProbing.value = false
  }
}

async function saveEmbeddings() {
  embError.value = ''
  // Saving an unreachable model would leave memory unable to index or search.
  if (!await probeDimensions()) return
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
    savedEmbedding.value = { providerId: embProviderId.value, model: embModel.value, dimensions: res.dimensions }
    embStatus.value = 'saved'
    embError.value = ''
  } catch (error) {
    embStatus.value = 'error'
    embError.value = `Embedding settings were not saved: ${error instanceof Error ? error.message : 'unknown error'}`
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
    <SettingsSubheading
      v-if="showAnySection(['embedding-model', 'reranker'])"
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
            class="w-5 h-5 text-ink-secondary"
          />
        </div>
        <div>
          <h3 class="text-sm font-medium text-theme-200">
            Embedding Model
          </h3>
          <p class="text-xs text-ink-muted mt-0.5">
            Select the model for vector embeddings. Changing the model will offer to re-embed existing memories or drop them.
            For local embeddings, <span class="text-theme-300 font-medium">mxbai-embed-large</span> gives the best retrieval quality.
          </p>
        </div>
      </div>

      <div>
        <div class="flex items-center justify-between gap-3 mb-1">
          <label class="block text-xs text-ink-secondary">Model</label>
          <span
            v-if="embDimensions"
            class="text-[11px] text-ink-muted whitespace-nowrap"
          >
            {{ embDimensions }} dimensions
          </span>
        </div>
        <div class="flex gap-2">
          <ProviderModelSelect
            class="flex-1"
            :provider-id="embProviderId"
            :model-value="embModel"
            :providers="providerStore.providers"
            model-type="embedding"
            :include-provider-default="false"
            hide-empty-providers
            :refresh-key="embModelRefreshKey"
            placeholder="Select embedding model"
            dropdown-width="min-w-full"
            max-height="max-h-72"
            @change="updateEmbeddingSelection"
          />
          <button
            :disabled="providerStore.providers.length === 0"
            class="px-3 py-2 bg-theme-700 hover:bg-theme-600 disabled:bg-theme-800 disabled:text-ink-faint text-theme-300 text-sm rounded-lg transition-colors"
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
        <p
          v-if="hasLocalProvider"
          class="mt-1.5 text-[11px] text-ink-muted"
        >
          Local providers only list models they have installed. Add an embedding model there, then refresh.
        </p>
      </div>

      <p
        v-if="embError"
        class="rounded-lg border border-red-400/25 bg-red-400/10 px-3 py-2 text-xs text-status-danger"
        role="alert"
      >
        {{ embError }}
      </p>
      <div class="flex items-center justify-between gap-3">
        <SettingsPersistenceStatus
          mode="manual"
          :state="embStatus === 'error' ? 'error' : embSaving ? 'saving' : embDirty ? 'dirty' : embStatus"
        />
        <button
          :disabled="embSaving || embProbing || !embModel || !embDirty"
          class="ml-auto px-4 py-2 accent-action bg-accent-600 hover:bg-accent-500 disabled:bg-theme-700 disabled:text-ink-muted text-accent-on text-sm rounded-lg transition-colors"
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
              class="w-5 h-5 text-ink-secondary"
            />
          </div>
          <div>
            <h3 class="text-sm font-medium text-theme-200">
              Retrieval Reranker
            </h3>
            <p class="text-xs text-ink-muted mt-0.5">
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

      <div
        v-if="rerankEnabled"
        class="space-y-3"
      >
        <div>
          <label class="block text-xs text-ink-secondary mb-1">OpenRouter Provider / Model</label>
          <ProviderModelSelect
            :provider-id="rerankProviderId"
            :model-value="rerankModel"
            :providers="openRouterProviders"
            model-type="reranker"
            :include-provider-default="false"
            placeholder="Select OpenRouter rerank model"
            dropdown-width="min-w-full"
            max-height="max-h-72"
            only-show-available-models
            @change="updateRerankerSelection"
          />
          <p
            v-if="openRouterProviders.length === 0"
            class="text-xs text-status-warning mt-1"
          >
            Add an OpenRouter provider before enabling reranking.
          </p>
        </div>
      </div>

      <div v-else>
        <label class="block text-xs text-ink-secondary mb-1">Curation Model</label>
        <ProviderModelSelect
          :provider-id="curationProviderId"
          :model-value="curationModel"
          :providers="providerStore.providers"
          :model-types="['llm', 'decision']"
          :include-provider-default="false"
          include-default
          default-label="Use conversation model"
          placeholder="Use conversation model"
          dropdown-width="min-w-full"
          max-height="max-h-72"
          @change="updateCurationSelection"
        />
        <p class="text-xs text-ink-muted mt-1">
          Without a reranker, this model reviews the retrieved candidates and picks the memories to inject.
          OpenRouter decision models are listed too: they judge each candidate directly and are fast and cheap, but cannot suggest a retry query.
        </p>
      </div>

      <div class="flex items-center justify-between gap-3">
        <SettingsPersistenceStatus
          mode="manual"
          :state="rerankStatus === 'error' ? 'error' : rerankSaving ? 'saving' : rerankDirty ? 'dirty' : rerankStatus"
        />
        <button
          :disabled="rerankSaving || !rerankDirty || (rerankEnabled && (!rerankProviderId || !rerankModel))"
          class="ml-auto px-4 py-2 accent-action bg-accent-600 hover:bg-accent-500 disabled:bg-theme-700 disabled:text-ink-muted text-accent-on text-sm rounded-lg transition-colors"
          @click="saveReranker"
        >
          <span v-if="rerankSaving">Saving...</span>
          <span v-else>Save changes</span>
        </button>
      </div>
    </BaseCard>

    <SettingsSubheading
      v-if="showSection('dream-mode')"
      label="Building Knowledge"
    />

    <!-- Dream Mode -->
    <BaseCard
      v-if="showSection('dream-mode')"
      class="p-6 space-y-4 bg-dream-card"
    >
      <div class="flex items-center justify-between gap-4">
        <div>
          <h3 class="text-sm font-medium text-gray-200 flex items-center gap-2">
            <Icon
              icon="lucide:moon-star"
              class="w-5 h-5"
            />
            Dream Mode
          </h3>
          <p class="text-xs text-gray-500 mt-1">
            Automatically reviews new Free Chat activity and conversations from agents that explicitly allow Dreaming to learn useful facts and update memory.
            Checks every minute after a conversation has been inactive for 5 minutes, while the server is running.
            Uses model requests and may incur provider costs. Existing history is used only as context.
          </p>
        </div>
        <ToggleSwitch
          v-model="dreamEnabled"
          label="Enable Dream Mode"
          :disabled="!dreamLoaded || dreamSaving || (!dreamEnabled && !dreamSelectionValid)"
        />
      </div>
      <ProviderModelSelect
        :provider-id="dreamProviderId"
        :model-value="dreamModel"
        :providers="providerStore.providers"
        placeholder="Select Dream provider and model"
        dropdown-width="min-w-full"
        @change="(selection) => { dreamProviderId = selection.providerId; dreamModel = selection.model }"
      />
      <p
        v-if="dreamError"
        role="alert"
        class="text-xs text-status-danger"
      >
        {{ dreamError }}
      </p>
      <div class="flex items-center justify-between gap-3">
        <SettingsPersistenceStatus
          mode="manual"
          :state="dreamStatus === 'error' ? 'error' : dreamSaving ? 'saving' : dreamDirty ? 'dirty' : dreamStatus"
        />
        <button
          :disabled="!dreamLoaded || dreamSaving || !dreamDirty || (dreamEnabled && !dreamSelectionValid)"
          class="ml-auto px-4 py-2 accent-action bg-accent-600 hover:bg-accent-500 disabled:bg-theme-700 disabled:text-ink-muted text-accent-on text-sm rounded-lg"
          @click="saveDream"
        >
          {{ dreamSaving ? 'Saving...' : 'Save Dream Config' }}
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
      <p class="text-ink-secondary leading-relaxed">
        Changing the embedding provider or model makes existing vectors incompatible.
        You can <strong class="text-theme-200">re-embed</strong> all stored memories with the new model to preserve your data,
        or <strong class="text-theme-200">drop</strong> all vectors and re-upload files manually.
      </p>

      <!-- Re-embed progress bar -->
      <div
        v-if="reembedProgress"
        class="mt-4 space-y-2"
      >
        <div class="flex items-center justify-between text-xs text-ink-secondary">
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
          class="w-full px-4 py-3 accent-action bg-accent-600 hover:bg-accent-500 disabled:bg-theme-700 text-accent-on rounded-xl text-center font-medium transition-colors"
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

<style scoped>
.bg-dream-card
{
  background: url("../../assets/img/settings/bg-dream.png") no-repeat center center;
  background-size: cover;
  background-position: center center;
}

/*
.bg-knowledge-card
{
  background: url("../../assets/img/settings/bg-knowledge.png") no-repeat center center;
  background-size: cover;
  background-position: top center;
}
  */
</style>
