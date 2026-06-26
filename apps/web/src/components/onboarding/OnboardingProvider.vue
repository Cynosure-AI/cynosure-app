<template>
  <div class="max-w-2xl mx-auto px-4 py-6 w-full">
    <div class="mb-5">
      <h2 class="text-xl font-bold text-theme-100">
        Connect an AI Provider
      </h2>
      <p class="text-sm text-theme-500 mt-1">
        You need at least one provider to use Cynosure. You can add more later in Settings. <br> It is recommended to use <b>Deepseek-v4</b> as base model.
      </p>
    </div>

    <!-- Existing providers list -->
    <div
      v-if="providerStore.providers.length"
      class="mb-5 space-y-2"
    >
      <div class="text-xs font-medium text-theme-400 uppercase tracking-wider mb-2">
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
            :alt="provider.type"
            class="w-full h-full object-contain"
          >
          <span
            v-else
            class="text-sm font-bold text-theme-400"
          >{{ provider.type[0].toUpperCase() }}</span>
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-theme-200">
            {{ provider.name }}
          </div>
          <div class="text-xs text-theme-500 truncate">
            {{ provider.defaultModel }} · {{ provider.type }}
          </div>
        </div>
        <div class="flex items-center gap-1.5">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
          <span class="text-xs text-theme-500">Added</span>
        </div>
        <button
          class="p-1.5 text-theme-600 hover:text-red-400 transition-colors"
          @click="providerStore.removeProvider(provider.id)"
        >
          <Icon
            icon="lucide:x"
            class="w-3.5 h-3.5"
          />
        </button>
      </div>
    </div>

    <!-- Success notice after adding a provider -->
    <div
      v-if="lastAddedProvider"
      class="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-5 space-y-3"
    >
      <div class="flex items-start gap-3">
        <div class="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0 mt-0.5">
          <Icon
            icon="lucide:check"
            class="w-4 h-4 text-emerald-400"
          />
        </div>
        <div class="flex-1">
          <p class="text-sm font-semibold text-emerald-300">
            Provider added successfully!
          </p>
          <p class="text-xs text-theme-400 mt-0.5">
            <span class="text-theme-200 font-medium">{{ lastAddedProvider }}</span> is ready to use.
            You can add more providers or continue to the next step.
          </p>
        </div>
      </div>
      <button
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
      class="bg-theme-800/50 border border-theme-700/60 rounded-xl p-5 space-y-4"
    >
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold text-theme-200">
          {{ providerStore.providers.length ? 'Add Another Provider' : 'Add Your First Provider' }}
        </h3>
        <div class="flex items-center gap-2">
          <img
            v-if="providerLogos[form.type]"
            :src="providerLogos[form.type].dark"
            :alt="form.type"
            class="w-6 h-6 object-contain"
          >
        </div>
      </div>

      <!-- Provider type -->
      <div>
        <label class="block text-xs font-medium text-theme-400 mb-1.5">Provider Type</label>
        <select
          v-model="form.type"
          class="w-full bg-theme-900 border border-theme-600 text-theme-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500"
          @change="onTypeChange"
        >
          <option
            v-for="opt in providerOptions"
            :key="opt.value"
            :value="opt.value"
          >
            {{ opt.label }}
          </option>
        </select>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <!-- Name -->
        <div>
          <label class="block text-xs font-medium text-theme-400 mb-1.5">Display Name</label>
          <input
            v-model="form.name"
            type="text"
            placeholder="e.g. My OpenAI"
            class="w-full bg-theme-900 border border-theme-600 text-theme-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500 placeholder-theme-600"
          >
        </div>

        <!-- Base URL (local providers) -->
        <div v-if="hasEditableBaseUrl">
          <label class="block text-xs font-medium text-theme-400 mb-1.5">Base URL</label>
          <input
            v-model="form.baseUrl"
            type="text"
            :placeholder="defaultBaseUrls[form.type]"
            class="w-full bg-theme-900 border border-theme-600 text-theme-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500 placeholder-theme-600"
          >
        </div>

        <!-- API Key (cloud providers) -->
        <div v-else>
          <label class="block text-xs font-medium text-theme-400 mb-1.5">API Key</label>
          <div class="relative">
            <input
              v-model="form.apiKey"
              :type="showApiKey ? 'text' : 'password'"
              placeholder="sk-..."
              class="w-full bg-theme-900 border border-theme-600 text-theme-200 rounded-lg px-3 py-2 pr-9 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500 placeholder-theme-600"
            >
            <button
              type="button"
              class="absolute right-2.5 top-1/2 -translate-y-1/2 text-theme-500 hover:text-theme-300 transition-colors"
              @click="showApiKey = !showApiKey"
            >
              <Icon
                :icon="showApiKey ? 'lucide:eye-off' : 'lucide:eye'"
                class="w-4 h-4"
              />
            </button>
          </div>
        </div>
      </div>

      <!-- Model -->
      <div>
        <label class="block text-xs font-medium text-theme-400 mb-1.5">Default Model</label>
        <div class="flex gap-2">
          <div class="relative flex-1">
            <input
              v-if="!fetchedModels.length"
              v-model="form.defaultModel"
              type="text"
              :placeholder="defaultModels[form.type] || 'Enter model name'"
              class="w-full bg-theme-900 border border-theme-600 text-theme-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500 placeholder-theme-600"
            >
            <select
              v-else
              v-model="form.defaultModel"
              class="w-full bg-theme-900 border border-theme-600 text-theme-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500"
            >
              <option
                v-for="m in fetchedModels"
                :key="m"
                :value="m"
              >
                {{ m }}
              </option>
            </select>
          </div>
          <button
            class="px-3 py-2 bg-theme-700 hover:bg-theme-600 text-theme-300 text-sm rounded-lg transition-colors shrink-0 flex items-center gap-1.5 disabled:opacity-50"
            :disabled="loadingModels || (!form.apiKey && !hasEditableBaseUrl)"
            @click="fetchModels"
          >
            <Icon
              :icon="loadingModels ? 'lucide:loader-2' : 'lucide:refresh-cw'"
              class="w-3.5 h-3.5"
              :class="{ 'animate-spin': loadingModels }"
            />
            {{ loadingModels ? 'Loading…' : 'Fetch' }}
          </button>
        </div>
      </div>

      <!-- Error -->
      <p
        v-if="error"
        class="text-xs text-red-400"
      >
        {{ error }}
      </p>

      <!-- Add button -->
      <button
        class="w-full px-4 py-2.5 bg-accent-600 hover:bg-accent-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
        :disabled="!canAdd || saving"
        @click="addProvider"
      >
        <Icon
          v-if="saving"
          icon="lucide:loader-2"
          class="w-4 h-4 animate-spin"
        />
        <Icon
          v-else
          icon="lucide:plus"
          class="w-4 h-4"
        />
        {{ saving ? 'Adding…' : 'Add Provider' }}
      </button>
    </div>
    <!-- /v-else add form -->

    <!-- Validation note -->
    <p
      v-if="!providerStore.providers.length"
      class="text-xs text-amber-400/80 mt-3 flex items-center gap-1.5"
    >
      <Icon
        icon="lucide:info"
        class="w-3.5 h-3.5 shrink-0"
      />
      At least one provider is required to continue.
    </p>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive } from 'vue'
import { Icon } from '@iconify/vue'
import { useProviderStore } from '../../stores/provider.store'
import { useProviderLogos } from '../../composables/useProviderLogos'
import type { LLMProviderConfig, ModelListType } from '../../api/types'

const providerStore = useProviderStore()
const { providerLogos } = useProviderLogos()

type ProviderType = LLMProviderConfig['type']
const responseModelTypes: ModelListType[] = ['llm', 'image', 'video', 'transcription']

const showApiKey = ref(false)
const fetchedModels = ref<string[]>([])
const loadingModels = ref(false)
const saving = ref(false)
const error = ref('')
const lastAddedProvider = ref<string | null>(null)

const form = reactive<{
  name: string
  type: ProviderType
  baseUrl: string
  apiKey: string
  defaultModel: string
}>({
  name: 'OpenAI',
  type: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  defaultModel: 'gpt-4o',
})

const defaultBaseUrls: Record<ProviderType, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: '',
  lmstudio: 'http://localhost:1234/v1',
  grok: 'https://api.x.ai/v1',
  ollama: 'http://localhost:11434/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
}

const defaultModels: Record<ProviderType, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-20250514',
  google: 'gemini-2.0-flash',
  lmstudio: '',
  grok: 'grok-3-mini',
  ollama: '',
  openrouter: 'openai/gpt-4o',
  groq: 'llama-3.3-70b-versatile',
  mistral: 'mistral-large-latest',
}

const localProviders = new Set<ProviderType>(['lmstudio', 'ollama'])
const hasEditableBaseUrl = computed(() => localProviders.has(form.type))

const providerOptions: { value: ProviderType; label: string }[] = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'google', label: 'Google Gemini' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'groq', label: 'Groq' },
  { value: 'mistral', label: 'Mistral' },
  { value: 'grok', label: 'Grok (xAI)' },
  { value: 'ollama', label: 'Ollama (local)' },
  { value: 'lmstudio', label: 'LM Studio (local)' },
]

function onTypeChange() {
  form.baseUrl = defaultBaseUrls[form.type]
  form.defaultModel = defaultModels[form.type] || ''
  form.name = form.type.charAt(0).toUpperCase() + form.type.slice(1)
  if (form.type === 'google') form.name = 'Google Gemini'
  if (form.type === 'lmstudio') form.name = 'LM Studio'
  if (form.type === 'openrouter') form.name = 'OpenRouter'
  fetchedModels.value = []
  error.value = ''
}

const canAdd = computed(() => {
  if (!form.name || !form.defaultModel) return false
  if (hasEditableBaseUrl.value) return Boolean(form.baseUrl)
  return true // API key not strictly required to add
})

async function fetchModels() {
  const needsKey = !localProviders.has(form.type)
  if (needsKey && !form.apiKey) return

  const tempId = '__onboarding_temp_fetch__'
  const config: LLMProviderConfig = {
    id: tempId,
    name: 'temp',
    type: form.type,
    baseUrl: hasEditableBaseUrl.value ? (form.baseUrl || defaultBaseUrls[form.type]) : defaultBaseUrls[form.type],
    apiKey: form.apiKey || undefined,
    defaultModel: form.defaultModel || 'temp',
    availableModels: [],
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsVision: false,
  }

  loadingModels.value = true
  error.value = ''
  try {
    await providerStore.addProvider(config)
    fetchedModels.value = await listResponseModels(tempId)
  } catch {
    fetchedModels.value = []
  } finally {
    try { await providerStore.removeProvider(tempId) } catch { /* ignore */ }
    loadingModels.value = false
  }
}

async function listResponseModels(providerId: string): Promise<string[]> {
  const results = await Promise.all(
    responseModelTypes.map((type) => providerStore.listModels(providerId, type))
  )
  return Array.from(new Set(results.flat())).sort()
}

async function addProvider() {
  if (!canAdd.value) return
  saving.value = true
  error.value = ''
  try {
    const config: LLMProviderConfig = {
      id: '',
      name: form.name,
      type: form.type,
      baseUrl: hasEditableBaseUrl.value ? (form.baseUrl || defaultBaseUrls[form.type]) : defaultBaseUrls[form.type],
      apiKey: form.apiKey || undefined,
      defaultModel: form.defaultModel,
      availableModels: [],
      supportsStreaming: true,
      supportsToolCalls: true,
      supportsVision: ['openai', 'google', 'grok', 'ollama', 'lmstudio', 'openrouter', 'groq', 'mistral'].includes(form.type),
    }
    await providerStore.addProvider(config)
    lastAddedProvider.value = form.name
    // Reset form for potential next addition
    form.apiKey = ''
    form.name = ''
    form.defaultModel = ''
    fetchedModels.value = []
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to add provider'
  } finally {
    saving.value = false
  }
}
</script>
