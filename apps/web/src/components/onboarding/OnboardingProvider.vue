<template>
  <div class="max-w-2xl mx-auto px-4 py-6 w-full">
    <div class="mb-5">
      <h2 class="text-xl font-bold text-theme-100">
        Connect an AI Provider
      </h2>
      <p class="text-sm text-ink-muted mt-1">
        You need at least one provider to use Cynosure. You can add more later in Settings. <br> It is recommended to use <b>Deepseek-v4</b> as base model.
      </p>
    </div>

    <!-- Existing providers list -->
    <div
      v-if="providerStore.providers.length"
      class="mb-5 space-y-2"
    >
      <div class="text-xs font-medium text-ink-secondary uppercase tracking-wider mb-2">
        Added Providers
      </div>
      <div
        v-for="provider in providerStore.providers"
        :key="provider.id"
        class="flex items-center gap-3 bg-theme-800/60 border border-theme-700/60 rounded-xl px-4 py-3"
      >
        <div class="w-8 h-8 rounded-lg bg-theme-900 flex items-center justify-center p-1 shrink-0">
          <img
            v-if="providerLogos[provider.type]"
            :src="providerLogos[provider.type].dark"
            alt=""
            class="w-full h-full object-contain"
          >
          <span
            v-else
            class="text-sm font-bold text-ink-secondary"
          >{{ provider.type[0].toUpperCase() }}</span>
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-theme-200">
            {{ provider.name }}
          </div>
          <div class="text-xs text-ink-muted truncate">
            {{ provider.defaultModel }} · {{ provider.type }}
          </div>
        </div>
        <div class="flex items-center gap-1.5">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
          <span class="text-xs text-ink-muted">Added</span>
        </div>
        <button
          type="button"
          class="rounded-md p-1.5 text-ink-faint transition-colors hover:text-status-danger disabled:opacity-50"
          :aria-label="`Remove ${provider.name}`"
          :disabled="removingId === provider.id"
          @click="removeProvider(provider.id)"
        >
          <Icon
            :icon="removingId === provider.id ? 'lucide:loader-2' : 'lucide:x'"
            class="w-3.5 h-3.5"
            :class="{ 'animate-spin': removingId === provider.id }"
          />
        </button>
      </div>
      <p
        v-if="removeError"
        class="text-xs text-status-danger"
        role="alert"
      >
        {{ removeError }}
      </p>
    </div>

    <!-- Success notice after adding a provider -->
    <div
      v-if="lastAddedProvider"
      class="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-5 space-y-3"
      role="status"
    >
      <div class="flex items-start gap-3">
        <div class="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0 mt-0.5">
          <Icon
            icon="lucide:check"
            class="w-4 h-4 text-status-success"
          />
        </div>
        <div class="flex-1">
          <p class="text-sm font-semibold text-emerald-300">
            Provider added
          </p>
          <p class="text-xs text-ink-secondary mt-0.5">
            <span class="text-theme-200 font-medium">{{ lastAddedProvider }}</span> has been saved.
            You can add another provider or continue to the next step.
          </p>
        </div>
      </div>
      <button
        type="button"
        class="flex items-center gap-1.5 px-3 py-2 bg-theme-700 hover:bg-theme-600 text-theme-300 text-sm rounded-lg transition-colors"
        @click="lastAddedProvider = null"
      >
        <Icon
          icon="lucide:plus"
          class="w-3.5 h-3.5"
        />
        Add another provider
      </button>
    </div>

    <!-- Add provider form -->
    <div
      v-else
      class="bg-theme-800/50 border border-theme-700/60 rounded-xl p-5"
    >
      <h3 class="mb-4 text-sm font-semibold text-theme-200">
        {{ providerStore.providers.length ? 'Add Another Provider' : 'Add Your First Provider' }}
      </h3>
      <ProviderForm
        :key="formSession"
        submit-label="Add Provider"
        :saving="saving"
        :error="error"
        @submit="addProvider"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { Icon } from '@iconify/vue'
import { useProviderStore } from '../../stores/provider.store'
import { useProviderLogos } from '../../composables/useProviderLogos'
import ProviderForm, { type ProviderDraft } from '../settings/ProviderForm.vue'
import { providerSupportsVision } from '../../utils/provider-defaults'

const providerStore = useProviderStore()
const { providerLogos } = useProviderLogos()

const saving = ref(false)
const error = ref('')
const lastAddedProvider = ref<string | null>(null)
const formSession = ref(0)
const removingId = ref<string | null>(null)
const removeError = ref('')

async function addProvider(draft: ProviderDraft) {
  saving.value = true
  error.value = ''
  try {
    await providerStore.addProvider({
      id: '',
      name: draft.name,
      type: draft.type,
      baseUrl: draft.baseUrl,
      apiKey: draft.apiKey || undefined,
      defaultModel: draft.defaultModel,
      availableModels: [],
      supportsStreaming: true,
      supportsToolCalls: true,
      supportsVision: providerSupportsVision(draft.type),
    })
    lastAddedProvider.value = draft.name
    formSession.value += 1
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to add provider'
  } finally {
    saving.value = false
  }
}

async function removeProvider(id: string) {
  removingId.value = id
  removeError.value = ''
  try {
    await providerStore.removeProvider(id)
  } catch (e) {
    removeError.value = e instanceof Error ? e.message : 'Failed to remove provider'
  } finally {
    removingId.value = null
  }
}
</script>
