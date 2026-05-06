<script setup lang="ts">
import { ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import { usePreferencesStore, type ContextStrategy } from '../../stores/preferences.store'
import { useProviderStore } from '../../stores/provider.store'
import ProviderSelect from '../shared/ProviderSelect.vue'
import ModelSelect from '../shared/ModelSelect.vue'
import ToggleSwitch from '../shared/ToggleSwitch.vue'
import BaseCard from '../shared/BaseCard.vue'

const prefs = usePreferencesStore()
const providerStore = useProviderStore()

const contextStrategyOptions: { value: ContextStrategy; label: string; description: string }[] = [
  { value: 'sliding-window', label: 'Sliding Window', description: 'Keeps the most recent messages, trimming older ones' },
  { value: 'truncate-middle', label: 'Truncate Middle', description: 'Keeps the first and last messages, trimming the middle' },
  { value: 'none', label: 'No Trimming', description: 'Sends all messages - may fail if context is exceeded' },
]

const titleModels = ref<string[]>([])
const titleLoadingModels = ref(false)
const toolRouterModels = ref<string[]>([])
const toolRouterLoadingModels = ref(false)

async function fetchTitleModels(providerId: string) {
  if (!providerId) { titleModels.value = []; return }
  titleLoadingModels.value = true
  try {
    titleModels.value = await providerStore.listModels(providerId, 'llm')
  } catch { titleModels.value = [] }
  titleLoadingModels.value = false
}

watch(() => prefs.titleProviderId, (id, oldId) => {
  if (oldId !== undefined) prefs.titleModel = ''
  fetchTitleModels(id)
}, { immediate: true })

async function fetchToolRouterModels(providerId: string) {
  if (!providerId) { toolRouterModels.value = []; return }
  toolRouterLoadingModels.value = true
  try {
    toolRouterModels.value = await providerStore.listModels(providerId, 'llm')
  } catch { toolRouterModels.value = [] }
  toolRouterLoadingModels.value = false
}

watch(() => prefs.toolRouterProviderId, (id, oldId) => {
  if (oldId !== undefined) prefs.toolRouterModel = ''
  fetchToolRouterModels(id)
}, { immediate: true })
</script>

<template>
  <div class="space-y-4">
    <!-- Tool Router -->
    <BaseCard class="p-5 space-y-4">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg bg-zinc-900 flex items-center justify-center">
          <Icon
            icon="lucide:route"
            class="w-5 h-5 text-zinc-400"
          />
        </div>
        <div>
          <h3 class="text-sm font-medium text-zinc-200">
            Tool Router
          </h3>
          <p class="text-xs text-zinc-500 mt-0.5">
            Provider and model used to detect which tools a request needs
          </p>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3 pt-1 border-t border-zinc-700">
        <div>
          <label class="block text-xs text-zinc-400 mb-1.5">Provider</label>
          <ProviderSelect
            v-model="prefs.toolRouterProviderId"
            :providers="providerStore.providers"
            include-default
            default-label="Use chat provider"
            placeholder="Use chat provider"
          />
        </div>
        <div>
          <label class="block text-xs text-zinc-400 mb-1.5">Model</label>
          <ModelSelect
            v-model="prefs.toolRouterModel"
            :models="toolRouterModels"
            include-default
            :default-label="toolRouterLoadingModels ? 'Loading models...' : 'Use provider default'"
            :placeholder="toolRouterLoadingModels ? 'Loading models...' : 'Use provider default'"
            :filterable="true"
          />
        </div>
      </div>
    </BaseCard>

    <!-- Generate Chat Titles -->
    <BaseCard class="p-5 space-y-4">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-zinc-900 flex items-center justify-center">
            <Icon
              icon="lucide:heading"
              class="w-5 h-5 text-zinc-400"
            />
          </div>
          <div>
            <h3 class="text-sm font-medium text-zinc-200">
              Generate Chat Titles
            </h3>
            <p class="text-xs text-zinc-500 mt-0.5">
              Use AI to generate descriptive titles for chat conversations
            </p>
          </div>
        </div>
        <ToggleSwitch v-model="prefs.generateTitle" />
      </div>

      <div
        v-if="prefs.generateTitle"
        class="grid grid-cols-2 gap-3 pt-1 border-t border-zinc-700"
      >
        <div>
          <label class="block text-xs text-zinc-400 mb-1.5">Provider</label>
          <ProviderSelect
            v-model="prefs.titleProviderId"
            :providers="providerStore.providers"
            include-default
            default-label="Use chat provider"
            placeholder="Use chat provider"
          />
        </div>
        <div>
          <label class="block text-xs text-zinc-400 mb-1.5">Model</label>
          <ModelSelect
            v-model="prefs.titleModel"
            :models="titleModels"
            include-default
            :default-label="titleLoadingModels ? 'Loading models...' : 'Use provider default'"
            :placeholder="titleLoadingModels ? 'Loading models...' : 'Use provider default'"
            :filterable="true"
          />
        </div>
      </div>
    </BaseCard>

    <!-- Context Strategy -->
    <BaseCard class="p-5 space-y-3">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg bg-zinc-900 flex items-center justify-center">
          <Icon
            icon="lucide:scissors"
            class="w-5 h-5 text-zinc-400"
          />
        </div>
        <div>
          <h3 class="text-sm font-medium text-zinc-200">
            Context Strategy
          </h3>
          <p class="text-xs text-zinc-500 mt-0.5">
            How to manage conversation history when it exceeds the model's context window
          </p>
        </div>
      </div>
      <select
        :value="prefs.contextStrategy"
        class="w-full bg-zinc-900 border border-zinc-600 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
        @change="prefs.contextStrategy = ($event.target as HTMLSelectElement).value as ContextStrategy"
      >
        <option
          v-for="opt in contextStrategyOptions"
          :key="opt.value"
          :value="opt.value"
        >
          {{ opt.label }} - {{ opt.description }}
        </option>
      </select>
    </BaseCard>
  </div>
</template>
