<script setup lang="ts">
import { useChatStore } from '../../../stores/chat.store'
import { Icon } from '@iconify/vue'
import HoverTooltip from '../../shared/HoverTooltip.vue'

const chatStore = useChatStore()
</script>

<template>
  <HoverTooltip :max-width="260">
    <button
      class="relative p-2.5 rounded-xl transition-colors shrink-0 focus:outline-none focus:ring-1 focus:ring-accent-500"
      :class="chatStore.sessionThinkingEnabled
        ? 'text-accent-400 hover:text-accent-300'
        : 'text-theme-500 hover:text-theme-300'"
      aria-label="Thinking mode"
      @click="chatStore.sessionThinkingEnabled = !chatStore.sessionThinkingEnabled; chatStore.markOverridesModified()"
    >
      <Icon
        icon="lucide:lightbulb"
        class="h-5 w-5"
      />
    </button>
    <template #content>
      <div class="font-medium text-theme-300 mb-1.5">
        Thinking Mode
      </div>
      <div :class="chatStore.sessionThinkingEnabled ? 'text-emerald-400' : 'text-theme-500'">
        {{ chatStore.sessionThinkingEnabled ? 'Enabled' : 'Disabled' }}
      </div>
      <div class="text-theme-600 text-[10px] mt-1.5 border-t border-theme-800 pt-1.5">
        Click to toggle extended reasoning and planning tools
      </div>
      <div
        v-if="!chatStore.sessionThinkingEnabled"
        class="text-theme-600 text-[10px] mt-1"
      >
        Disabled: no planning layer is injected
      </div>
    </template>
  </HoverTooltip>
</template>
