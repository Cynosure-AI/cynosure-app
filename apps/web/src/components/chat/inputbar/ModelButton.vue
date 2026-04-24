<script setup lang="ts">
import { ref, computed } from 'vue'
import { useChatStore } from '../../../stores/chat.store'
import { useAgentDefinitionsStore } from '../../../stores/agent-definitions.store'
import { useProviderStore } from '../../../stores/provider.store'
import { Icon } from '@iconify/vue'
import HoverTooltip from '../../shared/HoverTooltip.vue'
import ModelSelectorModal from '../modals/ModelSelectorModal.vue'

const chatStore = useChatStore()
const agentDefs = useAgentDefinitionsStore()
const providerStore = useProviderStore()

const showModal = ref(false)

const selectedAgent = computed(() =>
  chatStore.activeAgentId ? agentDefs.get(chatStore.activeAgentId) : null
)

const currentProviderId = computed(() =>
  chatStore.sessionProviderOverride || selectedAgent.value?.providerId || providerStore.lastUsedProviderId
)

const currentProvider = computed(() =>
  providerStore.providers.find(p => p.id === currentProviderId.value)
)

const displayModel = computed(() => {
  const override = chatStore.sessionModelOverride
  if (override) {
    // Truncate long model names for display
    return override.length > 16 ? override.substring(0, 14) + '…' : override
  }
  const agentModel = selectedAgent.value?.model
  const providerDefault = currentProvider.value?.defaultModel
  const isProviderOverridden = chatStore.sessionProviderOverride &&
    chatStore.sessionProviderOverride !== selectedAgent.value?.providerId
  const effectiveDefault = isProviderOverridden ? providerDefault : (agentModel || providerDefault)
  if (effectiveDefault) {
    return effectiveDefault.length > 16 ? effectiveDefault.substring(0, 14) + '…' : effectiveDefault
  }
  return 'Default'
})
</script>

<template>
  <HoverTooltip
    v-if="currentProviderId"
    :max-width="200"
  >
    <button
      class="relative p-2.5 rounded-xl transition-colors shrink-0 focus:outline-none focus:ring-1 focus:ring-blue-500 text-zinc-500 hover:text-zinc-300"
      aria-label="Select model"
      @click="showModal = true"
    >
      <Icon
        icon="lucide:cpu"
        class="h-5 w-5"
      />
    </button>
    <template #content>
      <div class="font-medium text-zinc-300 mb-1">
        Model
      </div>
      <div class="text-xs text-zinc-400">
        {{ displayModel }}
      </div>
    </template>
  </HoverTooltip>

  <ModelSelectorModal v-model="showModal" />
</template>
