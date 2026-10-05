<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { Icon } from '@iconify/vue'
import { useProviderStore } from '../../stores/provider.store'
import type { LLMProviderConfig } from '../../api/types'
import ProviderCard from './ProviderCard.vue'
import ProviderForm, { type ProviderDraft } from './ProviderForm.vue'
import CollapsibleSection from '../shared/CollapsibleSection.vue'
import SettingsSubheading from './SettingsSubheading.vue'
import SettingsPersistenceStatus from './SettingsPersistenceStatus.vue'
import ModalDialog from '../shared/ModalDialog.vue'
import { providerSupportsVision } from '../../utils/provider-defaults'

const providerStore = useProviderStore()
const props = withDefaults(defineProps<{
  visibleSections?: string[]
}>(), {
  visibleSections: () => []
})
const emit = defineEmits<{ 'dirty-change': [dirty: boolean] }>()

const showAddForm = ref(false)
const editingProviderId = ref<string | null>(null)
/** Remounts the open form so each add/edit starts from fresh values. */
const formSession = ref(0)
const formDirty = ref(false)
const savingProvider = ref(false)
const saveError = ref('')
const testingId = ref<string | null>(null)
const testResults = ref<Record<string, { success: boolean; error?: string }>>({})
const providerToRemove = ref<LLMProviderConfig | null>(null)
const removingProvider = ref(false)
const removeError = ref('')
const showDraftDiscardConfirm = ref(false)
let pendingDraftDiscard: (() => void) | null = null

const draftOpen = computed(() => showAddForm.value || editingProviderId.value !== null)
const draftDirty = computed(() => draftOpen.value && formDirty.value)
watch(draftDirty, (dirty) => emit('dirty-change', dirty), { immediate: true })

function showSection(id: string): boolean {
  return props.visibleSections.length === 0 || props.visibleSections.includes(id)
}

function openForm(providerId: string | null): void {
  editingProviderId.value = providerId
  showAddForm.value = providerId === null
  formDirty.value = false
  saveError.value = ''
  formSession.value += 1
}

function closeForm(): void {
  showAddForm.value = false
  editingProviderId.value = null
  formDirty.value = false
  saveError.value = ''
}

async function saveProvider(draft: ProviderDraft): Promise<void> {
  const id = editingProviderId.value || ''
  const config: LLMProviderConfig = {
    id,
    name: draft.name,
    type: draft.type,
    baseUrl: draft.baseUrl,
    apiKey: draft.apiKey || undefined,
    defaultModel: draft.defaultModel,
    availableModels: [],
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsVision: providerSupportsVision(draft.type)
  }

  savingProvider.value = true
  saveError.value = ''
  try {
    const savedId = await providerStore.addProvider(config)
    // The saved config may connect differently; earlier test results no longer apply.
    testResults.value = Object.fromEntries(Object.entries(testResults.value).filter(([id]) => id !== savedId))
    closeForm()
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : 'The provider could not be saved.'
  } finally {
    savingProvider.value = false
  }
}

function toggleAddForm(): void {
  requestDraftDiscard(() => {
    if (showAddForm.value) closeForm()
    else openForm(null)
  })
}

function toggleEditProvider(provider: LLMProviderConfig): void {
  requestDraftDiscard(() => {
    if (editingProviderId.value === provider.id) closeForm()
    else openForm(provider.id)
  })
}

function cancelForm(): void {
  requestDraftDiscard(closeForm)
}

function requestDraftDiscard(action: () => void): void {
  if (!draftDirty.value) {
    action()
    return
  }
  pendingDraftDiscard = action
  showDraftDiscardConfirm.value = true
}

function keepDraft(): void {
  pendingDraftDiscard = null
  showDraftDiscardConfirm.value = false
}

function discardDraft(): void {
  const action = pendingDraftDiscard
  pendingDraftDiscard = null
  showDraftDiscardConfirm.value = false
  action?.()
}

async function testConnection(id: string): Promise<void> {
  testingId.value = id
  try {
    testResults.value = { ...testResults.value, [id]: await providerStore.testConnection(id) }
  } catch (error) {
    testResults.value = {
      ...testResults.value,
      [id]: { success: false, error: error instanceof Error ? error.message : 'The connection test could not run.' }
    }
  } finally {
    testingId.value = null
  }
}

function requestRemove(providerId: string): void {
  providerToRemove.value = providerStore.providers.find((provider) => provider.id === providerId) ?? null
  removeError.value = ''
}

function cancelRemove(): void {
  if (removingProvider.value) return
  providerToRemove.value = null
}

async function confirmRemove(): Promise<void> {
  const provider = providerToRemove.value
  if (!provider) return
  removingProvider.value = true
  removeError.value = ''
  try {
    await providerStore.removeProvider(provider.id)
    if (editingProviderId.value === provider.id) closeForm()
    providerToRemove.value = null
  } catch (error) {
    removeError.value = error instanceof Error ? error.message : 'The provider could not be removed.'
  } finally {
    removingProvider.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <SettingsSubheading
      v-if="showSection('provider-actions')"
      label="Provider Management"
    />

    <div
      v-if="showSection('provider-actions') && (providerStore.providers.length > 0 || showAddForm)"
      class="flex justify-end"
    >
      <button
        type="button"
        class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors"
        :class="showAddForm
          ? 'bg-theme-700 text-theme-200 hover:bg-theme-600'
          : 'accent-action bg-accent-600 text-accent-on hover:bg-accent-500'"
        @click="toggleAddForm"
      >
        <Icon
          :icon="showAddForm ? 'lucide:x' : 'lucide:plus'"
          class="h-4 w-4"
        />
        {{ showAddForm ? 'Cancel' : 'Add Provider' }}
      </button>
    </div>

    <!-- Add Provider Form -->
    <div
      v-if="showSection('provider-actions') && showAddForm"
      class="rounded-xl border border-theme-700 bg-theme-800 p-4"
    >
      <ProviderForm
        :key="formSession"
        submit-label="Add Provider"
        :saving="savingProvider"
        :error="saveError"
        @submit="saveProvider"
        @dirty-change="formDirty = $event"
      />
    </div>

    <!-- Provider List -->
    <div
      v-if="showSection('provider-actions')"
      class="space-y-3"
    >
      <CollapsibleSection
        v-for="provider in providerStore.providers"
        :key="provider.id"
        :model-value="editingProviderId === provider.id"
      >
        <template #trigger>
          <ProviderCard
            :provider="provider"
            :is-last-used="provider.id === providerStore.lastUsedProviderId"
            :is-testing="testingId === provider.id"
            :test-status="testResults[provider.id]?.success"
            :test-error="testResults[provider.id]?.error"
            @test="testConnection"
            @edit="toggleEditProvider"
            @remove="requestRemove"
          />
        </template>

        <div class="mb-1 mt-2 rounded-xl border border-theme-700 bg-theme-800 p-4">
          <ProviderForm
            v-if="editingProviderId === provider.id"
            :key="formSession"
            :initial="provider"
            submit-label="Save changes"
            :saving="savingProvider"
            :error="saveError"
            cancellable
            require-changes
            @submit="saveProvider"
            @cancel="cancelForm"
            @dirty-change="formDirty = $event"
          >
            <template #status="{ dirty }">
              <SettingsPersistenceStatus
                mode="manual"
                :state="saveError ? 'error' : savingProvider ? 'saving' : dirty ? 'dirty' : 'idle'"
                class="mr-auto"
              />
            </template>
          </ProviderForm>
        </div>
      </CollapsibleSection>

      <div
        v-if="providerStore.providers.length === 0 && !showAddForm"
        class="flex flex-col items-center rounded-xl border border-theme-800 bg-theme-900/50 px-6 py-10 text-center"
      >
        <div class="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-accent-500/10 text-accent-fg ring-1 ring-accent-500/20">
          <Icon
            icon="lucide:plug-zap"
            class="h-6 w-6"
          />
        </div>
        <h3 class="text-base font-semibold text-theme-100">
          No providers configured
        </h3>
        <p class="mt-1 max-w-sm text-sm text-ink-muted">
          Connect a hosted service such as OpenAI or Anthropic, or a local server like Ollama or LM Studio, to start chatting.
        </p>
        <button
          type="button"
          class="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-accent-on transition-colors accent-action hover:bg-accent-500"
          @click="openForm(null)"
        >
          <Icon
            icon="lucide:plus"
            class="h-4 w-4"
          />
          Add Provider
        </button>
      </div>
    </div>

    <ModalDialog
      :show="providerToRemove !== null"
      title="Remove provider?"
      icon="lucide:trash-2"
      icon-color="red"
      layer="nested"
      @close="cancelRemove"
    >
      <p class="text-sm leading-relaxed text-ink-secondary">
        <span class="font-medium text-theme-100">{{ providerToRemove?.name }}</span> and its saved API key will be removed.
        Agents and chats that use this provider will need another provider before they can run.
      </p>
      <p
        v-if="removeError"
        class="mt-3 rounded-lg border border-red-400/25 bg-red-400/10 px-3 py-2 text-xs text-status-danger"
        role="alert"
      >
        {{ removeError }}
      </p>
      <template #actions>
        <button
          type="button"
          class="w-full rounded-xl bg-red-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-red-500 disabled:cursor-wait disabled:opacity-60"
          :disabled="removingProvider"
          @click="confirmRemove"
        >
          {{ removingProvider ? 'Removing…' : 'Remove provider' }}
        </button>
        <button
          type="button"
          class="w-full rounded-xl bg-theme-800 px-4 py-3 text-sm font-medium text-theme-200 transition hover:bg-theme-700"
          :disabled="removingProvider"
          @click="cancelRemove"
        >
          Keep provider
        </button>
      </template>
    </ModalDialog>

    <ModalDialog
      :show="showDraftDiscardConfirm"
      title="Discard provider changes?"
      icon="lucide:triangle-alert"
      icon-color="amber"
      layer="nested"
      @close="keepDraft"
    >
      <p class="text-sm leading-relaxed text-ink-secondary">
        The provider form has changes that have not been saved.
      </p>
      <template #actions>
        <button
          type="button"
          class="w-full rounded-xl bg-red-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-red-500"
          @click="discardDraft"
        >
          Discard changes
        </button>
        <button
          type="button"
          class="w-full rounded-xl bg-theme-800 px-4 py-3 text-sm font-medium text-theme-200 transition hover:bg-theme-700"
          @click="keepDraft"
        >
          Keep editing
        </button>
      </template>
    </ModalDialog>
  </div>
</template>
