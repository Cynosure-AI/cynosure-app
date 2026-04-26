<script setup lang="ts">
import { ref, reactive, computed } from 'vue'
import { useProviderStore } from '../../stores/provider.store'
import type { LLMProviderConfig } from '../../api/types'
import { useProviderLogos } from '../../composables/useProviderLogos'
import CustomSelect, { type SelectOptionGroup } from '../shared/CustomSelect.vue'
import ProviderCard from './ProviderCard.vue'
import { Icon } from '@iconify/vue'

const { providerLogos } = useProviderLogos()

const providerStore = useProviderStore()

const showAddForm = ref(false)
const editingProviderId = ref<string | null>(null)
const testingId = ref<string | null>(null)
const showApiKey = ref(false)
const testResult = ref<Map<string, boolean>>(new Map())
const fetchedModels = ref<string[]>([])
const loadingModels = ref(false)
type ProviderType = LLMProviderConfig['type']

const newProvider = reactive<{
  name: string
  type: LLMProviderConfig['type']
  baseUrl: string
  apiKey: string
  defaultModel: string
}>({
  name: '',
  type: 'openai',
  baseUrl: '',
  apiKey: '',
  defaultModel: ''
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
  mistral: 'https://api.mistral.ai/v1'
}

const defaultModels: Record<ProviderType, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-20250514',
  google: 'gemini-3.1-flash-lite-preview',
  lmstudio: '',
  grok: 'grok-3-mini',
  ollama: '',
  openrouter: 'openai/gpt-4o',
  groq: 'llama-3.3-70b-versatile',
  mistral: 'mistral-large-latest'
}

const providerTypesWithEditableBaseUrl = new Set<ProviderType>(['lmstudio', 'ollama'])
const hasEditableBaseUrl = computed(() => providerTypesWithEditableBaseUrl.has(newProvider.type))
const resolvedBaseUrl = computed(() => getProviderBaseUrl(newProvider.type, newProvider.baseUrl))
const canSaveProvider = computed(() =>
  Boolean(newProvider.name && newProvider.defaultModel && (!hasEditableBaseUrl.value || newProvider.baseUrl))
)

function getProviderBaseUrl(type: ProviderType, baseUrl?: string): string {
  if (providerTypesWithEditableBaseUrl.has(type)) {
    return baseUrl || defaultBaseUrls[type]
  }
  return defaultBaseUrls[type]
}

function onTypeChange(): void {
  newProvider.baseUrl = getProviderBaseUrl(newProvider.type)
  newProvider.defaultModel = defaultModels[newProvider.type] || ''
  if (!newProvider.name) {
    newProvider.name = newProvider.type.charAt(0).toUpperCase() + newProvider.type.slice(1)
  }
  fetchedModels.value = []
}

async function fetchModelsForEdit(providerId: string): Promise<void> {
  loadingModels.value = true
  try {
    fetchedModels.value = await providerStore.listModels(providerId)
  } catch {
    fetchedModels.value = []
  } finally {
    loadingModels.value = false
  }
}

async function fetchModelsForNew(): Promise<void> {
  // We need at least the apiKey (for cloud providers) or baseUrl (for local)
  const needsKey = newProvider.type !== 'lmstudio' && newProvider.type !== 'ollama'
  if (needsKey && !newProvider.apiKey) return
  if (hasEditableBaseUrl.value && !newProvider.baseUrl) return

  // Temporarily register provider, fetch models, then clean up
  const tempId = '__temp_model_fetch__'
  const config: LLMProviderConfig = {
    id: tempId,
    name: 'temp',
    type: newProvider.type,
    baseUrl: resolvedBaseUrl.value,
    apiKey: newProvider.apiKey || undefined,
    defaultModel: newProvider.defaultModel || 'temp',
    availableModels: [],
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsVision: false
  }

  loadingModels.value = true
  try {
    await providerStore.addProvider(config)
    fetchedModels.value = await providerStore.listModels(tempId)
  } catch {
    fetchedModels.value = []
  } finally {
    try { await providerStore.removeProvider(tempId) } catch { /* ignore */ }
    loadingModels.value = false
  }
}

async function addProvider(): Promise<void> {
  const config: LLMProviderConfig = {
    id: editingProviderId.value || '',
    name: newProvider.name,
    type: newProvider.type,
    baseUrl: resolvedBaseUrl.value,
    apiKey: newProvider.apiKey || undefined,
    defaultModel: newProvider.defaultModel,
    availableModels: [],
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsVision:
      newProvider.type === 'lmstudio' ||
      newProvider.type === 'openai' ||
      newProvider.type === 'google' ||
      newProvider.type === 'grok' ||
      newProvider.type === 'ollama' ||
      newProvider.type === 'openrouter' ||
      newProvider.type === 'groq' ||
      newProvider.type === 'mistral'
  }

  await providerStore.addProvider(config)

  // Reset form
  newProvider.name = ''
  newProvider.type = 'openai'
  newProvider.baseUrl = getProviderBaseUrl(newProvider.type)
  newProvider.apiKey = ''
  newProvider.defaultModel = ''
  editingProviderId.value = null
  showAddForm.value = false
}

function startAddProvider(): void {
  editingProviderId.value = null
  newProvider.name = ''
  newProvider.type = 'openai'
  newProvider.baseUrl = getProviderBaseUrl(newProvider.type)
  newProvider.apiKey = ''
  newProvider.defaultModel = ''
  fetchedModels.value = []
  showAddForm.value = true
}

function startEditProvider(provider: LLMProviderConfig): void {
  editingProviderId.value = provider.id
  newProvider.name = provider.name
  newProvider.type = provider.type
  newProvider.baseUrl = getProviderBaseUrl(provider.type, provider.baseUrl)
  newProvider.apiKey = provider.apiKey || ''
  newProvider.defaultModel = provider.defaultModel
  fetchedModels.value = []
  showApiKey.value = false
  showAddForm.value = true
  fetchModelsForEdit(provider.id)
}

function cancelForm(): void {
  showAddForm.value = false
  editingProviderId.value = null
}

async function testConnection(id: string): Promise<void> {
  testingId.value = id
  const result = await providerStore.testConnection(id)
  testResult.value.set(id, result)
  testingId.value = null
}

const modelSelectGroups = computed<SelectOptionGroup[]>(() => {
  if (!fetchedModels.value.length) {
    // When no models fetched, show current value as single option (if set)
    if (newProvider.defaultModel) {
      return [{ options: [{ value: newProvider.defaultModel, label: newProvider.defaultModel }] }]
    }
    return [{ options: [] }]
  }
  return [{
    options: fetchedModels.value.map(m => ({ value: m, label: m }))
  }]
})
</script>

<template>
  <div>
    <div class="flex items-center justify-end mb-4">
      <button
        class="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors"
        @click="showAddForm ? cancelForm() : startAddProvider()"
      >
        {{ showAddForm ? 'Cancel' : 'Add Provider' }}
      </button>
    </div>

    <!-- Add/Edit Provider Form -->
    <div
      v-if="showAddForm"
      class="bg-zinc-800 border border-zinc-700 rounded-xl p-4 mb-6 space-y-4"
    >
      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="block text-sm text-zinc-400 mb-1">Type</label>
          <div class="flex items-center gap-2">
            <img
              v-if="providerLogos[newProvider.type]"
              :src="providerLogos[newProvider.type].dark"
              :alt="newProvider.type"
              class="w-8 h-8 object-contain shrink-0 dark:block hidden"
            >
            <img
              v-if="providerLogos[newProvider.type]"
              :src="providerLogos[newProvider.type].light"
              :alt="newProvider.type"
              class="w-8 h-8 object-contain shrink-0 dark:hidden block"
            >
            <select
              v-model="newProvider.type"
              class="flex-1 bg-zinc-900 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
              @change="onTypeChange"
            >
              <option value="openai">
                OpenAI
              </option>
              <option value="anthropic">
                Anthropic (Claude)
              </option>
              <option value="google">
                Google (Gemini)
              </option>
              <option value="grok">
                Grok (xAI)
              </option>
              <option value="lmstudio">
                LM Studio
              </option>
              <option value="ollama">
                Ollama
              </option>
              <option value="openrouter">
                OpenRouter
              </option>
              <option value="groq">
                Groq
              </option>
              <option value="mistral">
                Mistral
              </option>
            </select>
          </div>
        </div>
        <div>
          <label class="block text-sm text-zinc-400 mb-1">Name</label>
          <input
            v-model="newProvider.name"
            type="text"
            placeholder="My Provider"
            class="w-full bg-zinc-900 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-600"
          >
        </div>
      </div>

      <div v-if="hasEditableBaseUrl">
        <label class="block text-sm text-zinc-400 mb-1">Base URL</label>
        <input
          v-model="newProvider.baseUrl"
          type="text"
          :placeholder="defaultBaseUrls[newProvider.type]"
          class="w-full bg-zinc-900 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-600"
        >
      </div>

      <div>
        <label class="block text-sm text-zinc-400 mb-1">API Key</label>
        <div class="relative">
          <input
            v-model="newProvider.apiKey"
            :type="showApiKey ? 'text' : 'password'"
            placeholder="sk-..."
            class="w-full bg-zinc-900 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 pr-9 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-600"
          >
          <button
            type="button"
            class="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
            :title="showApiKey ? 'Hide API key' : 'Show API key'"
            @click="showApiKey = !showApiKey"
          >
            <Icon
              :icon="showApiKey ? 'lucide:eye-off' : 'lucide:eye'"
              class="w-4 h-4"
            />
          </button>
        </div>
      </div>

      <div>
        <label class="block text-sm text-zinc-400 mb-1">Default Model</label>
        <div class="flex gap-2">
          <div class="flex-1">
            <CustomSelect
              v-if="fetchedModels.length > 0"
              :model-value="newProvider.defaultModel"
              :groups="modelSelectGroups"
              placeholder="Select a model..."
              filterable
              @update:model-value="newProvider.defaultModel = $event"
            />
            <input
              v-else
              v-model="newProvider.defaultModel"
              type="text"
              placeholder="gpt-4o"
              class="w-full bg-zinc-900 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-600"
            >
          </div>
          <button
            v-if="!editingProviderId"
            type="button"
            :disabled="loadingModels"
            class="px-3 py-2 bg-zinc-700 hover:bg-zinc-600 disabled:bg-zinc-800 disabled:text-zinc-600 text-zinc-300 text-sm rounded-lg transition-colors whitespace-nowrap"
            @click="fetchModelsForNew"
          >
            {{ loadingModels ? 'Loading…' : 'Fetch Models' }}
          </button>
          <button
            v-else
            type="button"
            :disabled="loadingModels"
            class="px-3 py-2 bg-zinc-700 hover:bg-zinc-600 disabled:bg-zinc-800 disabled:text-zinc-600 text-zinc-300 text-sm rounded-lg transition-colors whitespace-nowrap"
            @click="fetchModelsForEdit(editingProviderId!)"
          >
            {{ loadingModels ? 'Loading…' : 'Refresh' }}
          </button>
        </div>
      </div>

      <button
        :disabled="!canSaveProvider"
        class="w-full px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm rounded-lg transition-colors"
        @click="addProvider"
      >
        {{ editingProviderId ? 'Save Changes' : 'Add Provider' }}
      </button>
    </div>

    <!-- Provider List -->
    <div class="space-y-3">
      <ProviderCard
        v-for="provider in providerStore.providers"
        v-show="provider.id !== editingProviderId"
        :key="provider.id"
        :provider="provider"
        :is-last-used="provider.id === providerStore.lastUsedProviderId"
        :is-testing="testingId === provider.id"
        :test-status="testResult.get(provider.id)"
        @test="testConnection"
        @edit="startEditProvider"
        @remove="providerStore.removeProvider"
      />

      <div
        v-if="providerStore.providers.length === 0 && !showAddForm"
        class="text-center py-12 text-zinc-500"
      >
        <p class="text-lg mb-2">
          No providers configured
        </p>
        <p class="text-sm">
          Add an LLM provider to start chatting
        </p>
      </div>
    </div>
  </div>
</template>
