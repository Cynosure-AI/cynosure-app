<template>
  <div class="mx-auto w-full max-w-2xl px-4 py-8">
    <OnboardingStepHeader
      icon="lucide:plug-zap"
      title="Connect an AI Provider"
    >
      Cynosure needs at least one provider to talk to models. Pick one, paste your key, and you're good to go.
    </OnboardingStepHeader>

    <!-- Existing providers list -->
    <div
      v-if="providerStore.providers.length"
      class="mb-5 space-y-2"
    >
      <div
        v-for="provider in providerStore.providers"
        :key="provider.id"
        class="flex items-center gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-4 py-3"
      >
        <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-theme-900 p-1.5 ring-1 ring-theme-700">
          <img
            v-if="logoUrl(provider.type)"
            :src="logoUrl(provider.type)!"
            alt=""
            class="h-full w-full object-contain"
          >
          <span
            v-else
            class="text-sm font-bold text-ink-secondary"
          >{{ provider.type[0].toUpperCase() }}</span>
        </div>
        <div class="min-w-0 flex-1">
          <div class="text-sm font-medium text-theme-100">
            {{ provider.name }}
          </div>
          <div class="truncate text-xs text-ink-muted">
            {{ provider.defaultModel }}
          </div>
        </div>
        <span class="flex items-center gap-1.5 text-xs font-medium text-status-success">
          <Icon
            icon="lucide:circle-check"
            class="h-3.5 w-3.5"
          />
          Added
        </span>
        <button
          type="button"
          class="rounded-md p-1.5 text-ink-faint transition-colors hover:text-status-danger disabled:opacity-50"
          :aria-label="`Remove ${provider.name}`"
          :disabled="removingId === provider.id"
          @click="removeProvider(provider.id)"
        >
          <Icon
            :icon="removingId === provider.id ? 'lucide:loader-2' : 'lucide:x'"
            class="h-3.5 w-3.5"
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

    <!-- After adding a provider, the form folds away until the user wants another one -->
    <div
      v-if="providerStore.providers.length && !addingAnother"
      class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-theme-700/60 bg-theme-800/40 px-4 py-3"
      role="status"
    >
      <p class="text-sm text-ink-secondary">
        <template v-if="lastAddedProvider">
          <span class="font-medium text-theme-100">{{ lastAddedProvider }}</span> is ready. Continue, or add another provider.
        </template>
        <template v-else>
          A provider is set up. Continue, or add another one.
        </template>
      </p>
      <button
        type="button"
        class="inline-flex items-center gap-1.5 rounded-lg bg-theme-700 px-3 py-1.5 text-xs font-medium text-theme-200 transition-colors hover:bg-theme-600"
        @click="addingAnother = true"
      >
        <Icon
          icon="lucide:plus"
          class="h-3.5 w-3.5"
        />
        Add another
      </button>
    </div>

    <div
      v-else
      class="space-y-5"
    >
      <!-- Provider picker -->
      <div
        v-for="group in providerGroups"
        :key="group.label"
      >
        <div class="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-ink-muted">
          <Icon
            :icon="group.icon"
            class="h-3.5 w-3.5"
          />
          {{ group.label }}
        </div>
        <div
          class="grid grid-cols-2 gap-2"
          :class="group.local ? 'sm:grid-cols-3' : 'sm:grid-cols-4'"
        >
          <button
            v-for="option in group.options"
            :key="option.value"
            type="button"
            class="provider-tile"
            :class="{ 'provider-tile--active': selectedType === option.value }"
            :aria-pressed="selectedType === option.value"
            @click="selectedType = option.value"
          >
            <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-theme-950/70 p-1.5 ring-1 ring-theme-700/70">
              <img
                v-if="logoUrl(option.value)"
                :src="logoUrl(option.value)!"
                alt=""
                class="h-full w-full object-contain"
              >
            </span>
            <span class="min-w-0 text-left">
              <span class="block truncate text-sm font-medium text-theme-100">{{ TILE_NAMES[option.value] ?? PROVIDER_DISPLAY_NAMES[option.value] }}</span>
              <span class="block truncate text-[11px] text-ink-faint">{{ PROVIDER_TAGLINES[option.value] }}</span>
            </span>
          </button>
        </div>
      </div>

      <p class="flex items-start gap-2 text-xs leading-5 text-ink-muted">
        <Icon
          icon="lucide:lightbulb"
          class="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-fg"
        />
        <span>Not sure? We recommend <b class="font-semibold text-ink-secondary">DeepSeek V4</b> as your base model.</span>
      </p>

      <!-- Credentials for the chosen provider -->
      <div class="rounded-2xl border border-theme-700/60 bg-theme-800/50 p-5 shadow-sm">
        <div class="mb-4 flex items-center justify-between gap-3">
          <h3 class="text-sm font-semibold text-theme-100">
            Connect {{ PROVIDER_DISPLAY_NAMES[selectedType] }}
          </h3>
          <button
            v-if="providerStore.providers.length"
            type="button"
            class="text-xs text-ink-muted transition-colors hover:text-theme-200"
            @click="addingAnother = false"
          >
            Cancel
          </button>
        </div>
        <ProviderForm
          :key="`${selectedType}-${formSession}`"
          :initial="{ type: selectedType }"
          hide-type
          auto-load-models
          submit-label="Add Provider"
          :saving="saving"
          :error="error"
          @submit="addProvider"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { Icon } from '@iconify/vue'
import { useProviderStore } from '../../stores/provider.store'
import { useProviderLogos } from '../../composables/useProviderLogos'
import ProviderForm, { type ProviderDraft } from '../settings/ProviderForm.vue'
import OnboardingStepHeader from './OnboardingStepHeader.vue'
import {
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_OPTIONS,
  isLocalProvider,
  providerSupportsVision,
  type ProviderType,
} from '../../utils/provider-defaults'

const providerStore = useProviderStore()
const { logoUrl } = useProviderLogos()

/** Shorter names where the full one does not fit a tile. */
const TILE_NAMES: Partial<Record<ProviderType, string>> = { google: 'Gemini' }

const PROVIDER_TAGLINES: Record<ProviderType, string> = {
  openai: 'GPT models',
  anthropic: 'Claude models',
  google: 'by Google',
  openrouter: 'Many models',
  requesty: 'Model router',
  groq: 'Ultra-fast',
  mistral: 'Mistral models',
  grok: 'xAI models',
  ollama: 'Free, runs offline',
  lmstudio: 'Desktop model runner',
  unsloth: 'Your fine-tuned models',
}

const providerGroups = [
  { label: 'Cloud', icon: 'lucide:cloud', local: false, options: PROVIDER_OPTIONS.filter(o => !isLocalProvider(o.value)) },
  { label: 'Run locally', icon: 'lucide:hard-drive', local: true, options: PROVIDER_OPTIONS.filter(o => isLocalProvider(o.value)) },
]

const selectedType = ref<ProviderType>('openai')
const addingAnother = ref(false)
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
    addingAnother.value = false
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
    if (!providerStore.providers.length) lastAddedProvider.value = null
  } catch (e) {
    removeError.value = e instanceof Error ? e.message : 'Failed to remove provider'
  } finally {
    removingId.value = null
  }
}
</script>

<style scoped>
.provider-tile {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: .625rem;
  padding: .625rem .75rem;
  border: 1px solid color-mix(in srgb, var(--color-theme-600) 40%, transparent);
  border-radius: .75rem;
  background: color-mix(in srgb, var(--color-theme-800) 45%, transparent);
  transition: border-color 150ms ease, background-color 150ms ease, box-shadow 150ms ease, transform 150ms ease;
}

.provider-tile:hover {
  border-color: color-mix(in srgb, var(--color-theme-500) 60%, transparent);
  background: color-mix(in srgb, var(--color-theme-800) 75%, transparent);
}

.provider-tile:active {
  transform: scale(.98);
}

.provider-tile--active,
.provider-tile--active:hover {
  border-color: var(--color-accent-500);
  background: color-mix(in srgb, var(--color-accent-500) 10%, var(--color-theme-800));
  box-shadow: 0 0 0 1px var(--color-accent-500), 0 6px 20px -8px color-mix(in srgb, var(--color-accent-500) 45%, transparent);
}
</style>
