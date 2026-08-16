<script setup lang="ts">
import { ref, computed } from 'vue'
import { useChatStore } from '../../../stores/chat.store'
import { Icon } from '@iconify/vue'
import HoverTooltip from '../../shared/HoverTooltip.vue'
import ModelSelectorModal from '../modals/ModelSelectorModal.vue'

const chatStore = useChatStore()
const showModal = ref(false)

const currentProviderId = computed(() => chatStore.resolvedModelProvider?.providerId || '')

const displayModel = computed(() => {
  const effectiveDefault = chatStore.resolvedModelProvider?.model
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
      class="relative p-2.5 rounded-xl transition-colors shrink-0 focus:outline-none focus:ring-1 focus:ring-accent-500 text-theme-500 hover:text-theme-300"
      aria-label="Select model"
      @click="showModal = true"
    >
      <Icon
        icon="lucide:cpu"
        class="h-5 w-5"
      />
    </button>
    <template #content>
      <div class="font-medium text-theme-300 mb-1">
        Model
      </div>
      <div class="text-xs text-theme-400">
        {{ displayModel }}
      </div>
    </template>
  </HoverTooltip>

  <ModelSelectorModal v-model="showModal" />
</template>
