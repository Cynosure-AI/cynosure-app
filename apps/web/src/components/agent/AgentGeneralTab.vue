<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useProviderStore } from '../../stores/provider.store'
import type { AgentDefinition } from '../../api/types'
import { Icon } from '@iconify/vue'
import IconUpload from '../shared/IconUpload.vue'
import CustomSelect, { type SelectOptionGroup } from '../shared/CustomSelect.vue'
import { useProviderLogos } from '../../composables/useProviderLogos'

const props = defineProps<{ agent: AgentDefinition }>()
const emit = defineEmits<{ update: [field: string, value: unknown] }>()

const providerStore = useProviderStore()
const { logoUrl } = useProviderLogos()
const fetchedModels = ref<string[]>([])
const loadingModels = ref(false)
const systemPromptRef = ref<HTMLTextAreaElement | null>(null)

const providerGroups = computed((): SelectOptionGroup[] => [{
  options: providerStore.providers.map(p => ({
    value: p.id,
    label: p.name,
    imgSrc: logoUrl(p.type),
  })),
}])

const modelGroups = computed((): SelectOptionGroup[] => [{
  options: [
    { value: '', label: 'Use provider default', iconName: 'lucide:settings' },
    ...fetchedModels.value.map(m => ({ value: m, label: m })),
  ],
}])

async function fetchModelsForProvider(providerId: string) {
  if (!providerId) {
    fetchedModels.value = []
    return
  }
  loadingModels.value = true
  try {
    fetchedModels.value = await providerStore.listModels(providerId, 'llm')
  } catch {
    fetchedModels.value = []
  } finally {
    loadingModels.value = false
  }
}

function autoResize(e: Event) {
  const el = e.target as HTMLTextAreaElement
  el.style.height = 'auto'
  el.style.height = el.scrollHeight + 'px'
}

onMounted(() => nextTick(() => {
  if (systemPromptRef.value) {
    systemPromptRef.value.style.height = 'auto'
    systemPromptRef.value.style.height = systemPromptRef.value.scrollHeight + 'px'
  }
}))

// Fetch models on mount if provider is set
if (props.agent.providerId) {
  fetchModelsForProvider(props.agent.providerId)
}

watch(() => props.agent.providerId, (newId) => {
  // Reset the model whenever the provider changes so stale model IDs
  // from the old provider don't get sent to the new provider.
  emit('update', 'model', '')
  if (newId) fetchModelsForProvider(newId)
  else fetchedModels.value = []
})
</script>

<template>
  <div class="space-y-5 mb-6">
    <!-- Icon -->
    <IconUpload
      :icon-url="agent.iconUrl"
      fallback-icon="lucide:bot"
      @update="emit('update', 'iconUrl', $event)"
    >
      <template #description>
        Custom avatar for this agent. Falls back to the provider icon if not set.
      </template>
    </IconUpload>

    <div>
      <label class="block text-sm text-zinc-400 mb-1.5">Name</label>
      <input
        :value="agent.name"
        type="text"
        class="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
        @change="emit('update', 'name', ($event.target as HTMLInputElement).value)"
      >
    </div>

    <div>
      <label class="block text-sm text-zinc-400 mb-1.5">Description</label>
      <textarea
        :value="agent.description"
        class="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none h-20"
        @change="emit('update', 'description', ($event.target as HTMLTextAreaElement).value)"
      />
    </div>

    <div>
      <label class="block text-sm text-zinc-400 mb-1.5">LLM Provider</label>
      <CustomSelect
        :model-value="agent.providerId"
        :groups="providerGroups"
        placeholder="Select provider"
        placeholder-icon="lucide:cpu"
        @update:model-value="emit('update', 'providerId', $event)"
      />
    </div>

    <div>
      <label class="block text-sm text-zinc-400 mb-1.5">Model</label>
      <p class="text-xs text-zinc-600 mb-2">
        Overrides the provider's default model for this agent. Leave empty to use the provider default.
      </p>
      <div class="flex gap-2">
        <div class="flex-1">
          <CustomSelect
            :model-value="agent.model || ''"
            :groups="modelGroups"
            placeholder="Use provider default"
            placeholder-icon="lucide:settings"
            filterable
            @update:model-value="emit('update', 'model', $event)"
          />
        </div>
        <button
          type="button"
          :disabled="loadingModels || !agent.providerId"
          class="px-3 py-2 bg-zinc-700 hover:bg-zinc-600 disabled:bg-zinc-800 disabled:text-zinc-600 text-zinc-300 text-sm rounded-lg transition-colors whitespace-nowrap"
          @click="fetchModelsForProvider(agent.providerId)"
        >
          <Icon
            v-if="loadingModels"
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
      <label class="block text-sm text-zinc-400 mb-1.5">System Prompt</label>
      <p class="text-xs text-zinc-600 mb-2">
        Prepended as a system message alongside the built-in agentic instructions — does not replace them.
      </p>
      <textarea
        ref="systemPromptRef"
        :value="agent.systemPrompt"
        placeholder="Optional system instructions..."
        class="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none font-mono min-h-64"
        style="field-sizing: content"
        @change="emit('update', 'systemPrompt', ($event.target as HTMLTextAreaElement).value)"
        @input="autoResize"
      />
    </div>
  </div>
</template>
