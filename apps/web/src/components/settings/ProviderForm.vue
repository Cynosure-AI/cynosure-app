<script setup lang="ts">
import { computed, reactive, ref, useId, watch } from 'vue'
import { Icon } from '@iconify/vue'
import { api } from '../../api/client'
import { useProviderLogos } from '../../composables/useProviderLogos'
import CustomSelect, { type SelectOptionGroup } from '../shared/CustomSelect.vue'
import {
  DEFAULT_PROVIDER_BASE_URLS,
  DEFAULT_PROVIDER_MODELS,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_OPTIONS,
  RESPONSE_MODEL_TYPES,
  isLocalProvider,
  providerBaseUrl,
  providerRequiresApiKey,
  providerFormProblem,
  type ProviderType,
} from '../../utils/provider-defaults'

export interface ProviderDraft {
  type: ProviderType
  name: string
  baseUrl: string
  apiKey: string
  defaultModel: string
}

const props = withDefaults(defineProps<{
  /** Values to start from; omit for a new provider. */
  initial?: Partial<ProviderDraft>
  submitLabel: string
  saving?: boolean
  /** Error from the last save attempt, shown above the actions. */
  error?: string
  cancellable?: boolean
  /** Keep the submit button disabled until something changed (editing). */
  requireChanges?: boolean
}>(), {
  initial: undefined,
  saving: false,
  error: '',
  cancellable: false,
  requireChanges: false,
})

const emit = defineEmits<{
  submit: [draft: ProviderDraft]
  cancel: []
  'dirty-change': [dirty: boolean]
}>()

const { providerLogos } = useProviderLogos()
const fieldId = useId()

function startingDraft(): ProviderDraft {
  const type = props.initial?.type ?? 'openai'
  return {
    type,
    name: props.initial?.name ?? PROVIDER_DISPLAY_NAMES[type],
    baseUrl: providerBaseUrl(type, props.initial?.baseUrl),
    apiKey: props.initial?.apiKey ?? '',
    defaultModel: props.initial?.defaultModel ?? DEFAULT_PROVIDER_MODELS[type],
  }
}

const draft = reactive<ProviderDraft>(startingDraft())
const baseline = JSON.stringify(draft)
const dirty = computed(() => JSON.stringify(draft) !== baseline)
watch(dirty, (value) => emit('dirty-change', value), { immediate: true })

const showApiKey = ref(false)
const fetchedModels = ref<string[]>([])
const loadingModels = ref(false)
const modelsError = ref('')
const modelsLoadedFor = ref('')

const local = computed(() => isLocalProvider(draft.type))
const keyRequired = computed(() => providerRequiresApiKey(draft.type))
const problem = computed(() => providerFormProblem(draft))
const credentialsKey = computed(() => JSON.stringify([draft.type, draft.baseUrl.trim(), draft.apiKey.trim()]))
const missingBaseUrl = computed(() => local.value && !draft.baseUrl.trim())
const missingApiKey = computed(() => keyRequired.value && !draft.apiKey.trim())
const canFetchModels = computed(() => !missingBaseUrl.value && !missingApiKey.value)
const fetchHint = computed(() => missingBaseUrl.value ? 'Enter the base URL to load models.' : 'Enter an API key to load models.')

// A model list belongs to the credentials it was loaded with.
watch(credentialsKey, (key) => {
  if (key === modelsLoadedFor.value) return
  fetchedModels.value = []
  modelsError.value = ''
})

const modelGroups = computed<SelectOptionGroup[]>(() => {
  const models = draft.defaultModel && !fetchedModels.value.includes(draft.defaultModel)
    ? [draft.defaultModel, ...fetchedModels.value]
    : fetchedModels.value
  return [{ options: models.map((model) => ({ value: model, label: model })) }]
})

function onTypeChange(): void {
  const previousDefaultName = Object.values(PROVIDER_DISPLAY_NAMES).includes(draft.name)
  if (!draft.name.trim() || previousDefaultName) draft.name = PROVIDER_DISPLAY_NAMES[draft.type]
  draft.baseUrl = DEFAULT_PROVIDER_BASE_URLS[draft.type]
  draft.defaultModel = DEFAULT_PROVIDER_MODELS[draft.type]
}

async function fetchModels(): Promise<void> {
  if (!canFetchModels.value || loadingModels.value) return
  const requestedFor = credentialsKey.value
  loadingModels.value = true
  modelsError.value = ''
  try {
    const models = await api.provider.previewModels({
      type: draft.type,
      baseUrl: providerBaseUrl(draft.type, draft.baseUrl),
      apiKey: draft.apiKey.trim() || undefined,
    }, RESPONSE_MODEL_TYPES)
    if (requestedFor !== credentialsKey.value) return
    fetchedModels.value = models
    modelsLoadedFor.value = requestedFor
    if (models.length === 0) {
      modelsError.value = 'The provider returned no models. Enter a model name instead.'
    } else if (!draft.defaultModel) {
      draft.defaultModel = models[0]
    }
  } catch (error) {
    if (requestedFor !== credentialsKey.value) return
    fetchedModels.value = []
    modelsError.value = `Could not load models: ${error instanceof Error ? error.message : 'unknown error'}`
  } finally {
    loadingModels.value = false
  }
}

const submitDisabled = computed(() => Boolean(problem.value) || props.saving || (props.requireChanges && !dirty.value))

function submit(): void {
  if (submitDisabled.value) return
  emit('submit', {
    type: draft.type,
    name: draft.name.trim(),
    baseUrl: providerBaseUrl(draft.type, draft.baseUrl),
    apiKey: draft.apiKey.trim(),
    defaultModel: draft.defaultModel.trim(),
  })
}

const inputClass = 'w-full rounded-lg border border-theme-700 bg-theme-900 px-3 py-2 text-sm text-theme-200 placeholder:text-ink-faint focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500'
const labelClass = 'mb-1.5 block text-xs font-medium text-ink-secondary'
</script>

<template>
  <form
    class="space-y-4"
    novalidate
    @submit.prevent="submit"
  >
    <div class="grid gap-4 sm:grid-cols-2">
      <div>
        <label
          :for="`${fieldId}-type`"
          :class="labelClass"
        >Provider type</label>
        <div class="flex items-center gap-2">
          <span
            v-if="providerLogos[draft.type]"
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-theme-950 p-1.5 ring-1 ring-theme-700"
          >
            <img
              :src="providerLogos[draft.type].dark"
              alt=""
              class="hidden h-full w-full object-contain dark:block"
            >
            <img
              :src="providerLogos[draft.type].light"
              alt=""
              class="block h-full w-full object-contain dark:hidden"
            >
          </span>
          <select
            :id="`${fieldId}-type`"
            v-model="draft.type"
            :class="inputClass"
            @change="onTypeChange"
          >
            <option
              v-for="option in PROVIDER_OPTIONS"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </div>
      </div>

      <div>
        <label
          :for="`${fieldId}-name`"
          :class="labelClass"
        >Display name</label>
        <input
          :id="`${fieldId}-name`"
          v-model="draft.name"
          type="text"
          autocomplete="off"
          placeholder="e.g. Work OpenAI"
          :class="inputClass"
        >
      </div>
    </div>

    <div v-if="local">
      <label
        :for="`${fieldId}-base-url`"
        :class="labelClass"
      >Server base URL</label>
      <input
        :id="`${fieldId}-base-url`"
        v-model="draft.baseUrl"
        type="url"
        autocomplete="off"
        :placeholder="DEFAULT_PROVIDER_BASE_URLS[draft.type]"
        :class="inputClass"
      >
    </div>

    <div>
      <label
        :for="`${fieldId}-api-key`"
        :class="labelClass"
      >
        API key
        <span
          v-if="!keyRequired"
          class="font-normal text-ink-faint"
        >(optional)</span>
      </label>
      <div class="relative">
        <input
          :id="`${fieldId}-api-key`"
          v-model="draft.apiKey"
          :type="showApiKey ? 'text' : 'password'"
          autocomplete="off"
          spellcheck="false"
          :placeholder="keyRequired ? 'Paste your API key' : 'Only if your server requires one'"
          :class="[inputClass, 'pr-10']"
        >
        <button
          type="button"
          class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-ink-muted transition-colors hover:text-theme-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
          :aria-label="showApiKey ? 'Hide API key' : 'Show API key'"
          :aria-pressed="showApiKey"
          @click="showApiKey = !showApiKey"
        >
          <Icon
            :icon="showApiKey ? 'lucide:eye-off' : 'lucide:eye'"
            class="h-4 w-4"
          />
        </button>
      </div>
    </div>

    <div>
      <label
        :for="`${fieldId}-model`"
        :class="labelClass"
      >Default model</label>
      <div class="flex gap-2">
        <div class="min-w-0 flex-1">
          <CustomSelect
            v-if="fetchedModels.length > 0"
            :model-value="draft.defaultModel"
            :groups="modelGroups"
            placeholder="Select a model..."
            filterable
            aria-label="Default model"
            @update:model-value="draft.defaultModel = $event"
          />
          <input
            v-else
            :id="`${fieldId}-model`"
            v-model="draft.defaultModel"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :placeholder="DEFAULT_PROVIDER_MODELS[draft.type] || 'Model name'"
            :class="inputClass"
          >
        </div>
        <button
          type="button"
          class="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-theme-700 px-3 py-2 text-sm text-theme-200 transition-colors hover:bg-theme-600 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="!canFetchModels || loadingModels"
          :title="canFetchModels ? 'Load the models this provider offers' : fetchHint"
          @click="fetchModels"
        >
          <Icon
            :icon="loadingModels ? 'lucide:loader-2' : 'lucide:refresh-cw'"
            class="h-3.5 w-3.5"
            :class="{ 'animate-spin': loadingModels }"
          />
          {{ loadingModels ? 'Loading…' : 'Load models' }}
        </button>
      </div>
      <p
        v-if="modelsError"
        class="mt-1.5 text-xs text-status-danger"
        role="alert"
      >
        {{ modelsError }}
      </p>
      <p
        v-else-if="!canFetchModels"
        class="mt-1.5 text-xs text-ink-faint"
      >
        {{ fetchHint }}
      </p>
    </div>

    <p
      v-if="error"
      class="rounded-lg border border-red-400/25 bg-red-400/10 px-3 py-2 text-xs text-status-danger"
      role="alert"
    >
      {{ error }}
    </p>

    <div class="flex flex-wrap items-center justify-end gap-2">
      <slot
        name="status"
        :dirty="dirty"
      />
      <p
        v-if="problem && dirty"
        class="mr-auto text-xs text-ink-muted"
      >
        {{ problem }}
      </p>
      <button
        v-if="cancellable"
        type="button"
        class="rounded-lg bg-theme-700 px-4 py-2 text-sm text-theme-200 transition-colors hover:bg-theme-600"
        @click="emit('cancel')"
      >
        Cancel
      </button>
      <button
        type="submit"
        class="inline-flex items-center gap-2 rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-accent-on transition-colors accent-action hover:bg-accent-500 disabled:cursor-not-allowed disabled:bg-theme-700 disabled:text-ink-muted"
        :disabled="submitDisabled"
      >
        <Icon
          v-if="saving"
          icon="lucide:loader-2"
          class="h-4 w-4 animate-spin"
        />
        {{ saving ? 'Saving…' : submitLabel }}
      </button>
    </div>
  </form>
</template>
