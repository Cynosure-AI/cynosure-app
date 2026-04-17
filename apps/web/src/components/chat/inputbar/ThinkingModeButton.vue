<script setup lang="ts">
import { useChatStore } from '../../../stores/chat.store'
import { Icon } from '@iconify/vue'
import HoverTooltip from '../../shared/HoverTooltip.vue'

const chatStore = useChatStore()
</script>

<template>
  <HoverTooltip :max-width="260">
    <button
      class="relative p-2.5 rounded-xl transition-colors shrink-0 focus:outline-none focus:ring-1 focus:ring-blue-500"
      :class="chatStore.sessionThinkingEnabled
        ? 'text-blue-400 hover:text-blue-300'
        : 'text-zinc-500 hover:text-zinc-300'"
      aria-label="Thinking mode"
      @click="chatStore.sessionThinkingEnabled = !chatStore.sessionThinkingEnabled"
    >
      <Icon
        icon="lucide:lightbulb"
        class="h-5 w-5"
      />
    </button>
    <template #content>
      <div class="font-medium text-zinc-300 mb-1.5">
        Thinking Mode
      </div>
      <div :class="chatStore.sessionThinkingEnabled ? 'text-emerald-400' : 'text-zinc-500'">
        {{ chatStore.sessionThinkingEnabled ? 'Enabled' : 'Disabled' }}
      </div>
      <div class="text-zinc-600 text-[10px] mt-1.5 border-t border-zinc-800 pt-1.5">
        Click to toggle extended reasoning
      </div>
    </template>
  </HoverTooltip>
</template>
