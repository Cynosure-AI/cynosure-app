<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useChatStore } from '../../../stores/chat.store'
import { useAgentDefinitionsStore } from '../../../stores/agent-definitions.store'
import { useProviderStore } from '../../../stores/provider.store'
import { Icon } from '@iconify/vue'

const chatStore = useChatStore()
const agentDefs = useAgentDefinitionsStore()
const providerStore = useProviderStore()

const visible = defineModel<boolean>({ required: true })
const search = ref('')
const models = ref<string[]>([])
const loadingModels = ref(false)

const selectedAgent = computed(() =>
  chatStore.activeAgentId ? agentDefs.get(chatStore.activeAgentId) : null
)

const currentProviderId = computed(() =>
  chatStore.sessionProviderOverride || selectedAgent.value?.providerId || providerStore.lastUsedProviderId
)

const currentProvider = computed(() =>
  providerStore.providers.find(p => p.id === currentProviderId.value)
)

const defaultModelLabel = computed(() => {
  const agentModel = selectedAgent.value?.model
  const providerDefault = currentProvider.value?.defaultModel
  const isProviderOverridden = chatStore.sessionProviderOverride &&
    chatStore.sessionProviderOverride !== selectedAgent.value?.providerId
  const effectiveDefault = isProviderOverridden ? providerDefault : (agentModel || providerDefault)
  return effectiveDefault || 'Provider default'
})

const filteredModels = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return models.value
  return models.value.filter(m => m.toLowerCase().includes(q))
})

const selectedModel = computed(() => chatStore.sessionModelOverride || '')

async function fetchModels() {
  const providerId = currentProviderId.value
  if (!providerId) {
    models.value = []
    return
  }
  loadingModels.value = true
  try {
    models.value = await providerStore.listModels(providerId, 'llm')
  } catch {
    models.value = []
  } finally {
    loadingModels.value = false
  }
}

function selectModel(model: string) {
  chatStore.sessionModelOverride = model || null
  chatStore.markOverridesModified()
  visible.value = false
}

function selectDefault() {
  chatStore.sessionModelOverride = null
  chatStore.markOverridesModified()
  visible.value = false
}

// Fetch models when modal opens or provider changes
watch(visible, (isOpen) => {
  if (isOpen) fetchModels()
})
watch(currentProviderId, () => {
  if (visible.value) fetchModels()
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      @click.self="visible = false"
    >
      <div class="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-lg max-h-[70vh] flex flex-col">
        <!-- Header -->
        <div class="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <h3 class="text-sm font-semibold text-zinc-200">
            Select Model
          </h3>
          <button
            class="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
            @click="visible = false"
          >
            <Icon
              icon="mdi:close"
              class="h-4 w-4"
            />
          </button>
        </div>

        <!-- Search -->
        <div class="px-3 pt-2">
          <input
            v-model="search"
            type="text"
            placeholder="Search models…"
            class="w-full px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-500 outline-none focus:border-zinc-500 transition-colors"
          >
        </div>

        <!-- Model list -->
        <div class="flex-1 overflow-y-auto px-2 py-2 min-h-0">
          <!-- Loading state -->
          <div
            v-if="loadingModels"
            class="px-3 py-4 text-center text-sm text-zinc-500"
          >
            <Icon
              icon="lucide:loader-2"
              class="h-4 w-4 inline animate-spin mr-2"
            />
            Loading models…
          </div>

          <!-- Default option -->
          <button
            v-else
            class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors"
            :class="!selectedModel ? 'bg-blue-600/20 text-blue-400' : 'text-zinc-300 hover:bg-zinc-800'"
            @click="selectDefault"
          >
            <Icon
              icon="lucide:settings"
              class="h-4 w-4 shrink-0"
            />
            <span class="text-sm truncate">{{ defaultModelLabel }}</span>
            <Icon
              v-if="!selectedModel"
              icon="mdi:check"
              class="h-4 w-4 ml-auto text-blue-400 shrink-0"
            />
          </button>

          <!-- Models -->
          <button
            v-for="model in filteredModels"
            :key="model"
            class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors"
            :class="selectedModel === model ? 'bg-blue-600/20 text-blue-400' : 'text-zinc-300 hover:bg-zinc-800'"
            @click="selectModel(model)"
          >
            <Icon
              icon="lucide:cpu"
              class="h-4 w-4 shrink-0 text-zinc-500"
            />
            <span class="text-sm truncate">{{ model }}</span>
            <Icon
              v-if="selectedModel === model"
              icon="mdi:check"
              class="h-4 w-4 ml-auto text-blue-400 shrink-0"
            />
          </button>

          <!-- Empty state -->
          <div
            v-if="filteredModels.length === 0 && models.length > 0"
            class="px-3 py-4 text-center text-sm text-zinc-500"
          >
            No models match "{{ search }}"
          </div>
          <div
            v-else-if="models.length === 0"
            class="px-3 py-4 text-center text-sm text-zinc-500"
          >
            No models available for this provider
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
