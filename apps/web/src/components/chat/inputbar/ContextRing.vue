<script setup lang="ts">
import { computed } from 'vue'
import { useChatStore } from '../../../stores/chat.store'
import { useAgentDefinitionsStore } from '../../../stores/agent-definitions.store'
import HoverTooltip from '../../shared/HoverTooltip.vue'

const chatStore = useChatStore()
const agentDefs = useAgentDefinitionsStore()
const subAgentUsage = computed(() => chatStore.activeConversationId ? chatStore.subAgentUsage : null)

const contextUsage = computed(() => {
  // A new chat has no conversation-scoped usage yet. Treat it as empty even
  // if an asynchronous transition has not finished clearing store state.
  const usage = chatStore.activeConversationId ? chatStore.lastUsage : null
  const rawMax = chatStore.contextWindow
  if (!rawMax) return null

  let effectiveMax = rawMax

  // If the active agent has a hard max-context-token limit, cap the effective
  // context window so the ring reflects the tighter budget.
  const activeAgent = chatStore.activeAgentId ? agentDefs.get(chatStore.activeAgentId) : null
  const agentCap = activeAgent?.maxContextTokens
  const hasHardLimit = typeof agentCap === 'number' && agentCap > 0
  if (hasHardLimit) {
    effectiveMax = Math.min(rawMax, agentCap!)
  }

  if (!usage) {
    return { used: 0, max: effectiveMax, rawMax, percent: 0, hardLimit: hasHardLimit }
  }
  const used = usage.contextTokens ?? usage.totalTokens
  const percent = (used / effectiveMax) * 100
  return { used, max: effectiveMax, rawMax, percent, hardLimit: hasHardLimit }
})
</script>

<template>
  <HoverTooltip :disabled="!contextUsage">
    <div
      class="relative flex items-center justify-center shrink-0 self-end pb-0.75 w-9 h-9"
      :class="contextUsage ? '' : 'invisible'"
    >
      <svg
        v-if="contextUsage"
        class="w-9 h-9 -rotate-90"
        viewBox="0 0 36 36"
      >
        <!-- Background circle -->
        <circle
          cx="18"
          cy="18"
          r="14"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          :class="contextUsage.hardLimit ? 'text-amber-900/50' : 'text-theme-700/50'"
        />
        <!-- Progress arc -->
        <circle
          cx="18"
          cy="18"
          r="14"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          :stroke-dasharray="87.96"
          :stroke-dashoffset="Math.max(0, 87.96 - (87.96 * contextUsage.percent) / 100)"
          :class="contextUsage.percent > 90 ? 'text-red-500' : contextUsage.percent > 70 ? 'text-amber-400' : 'text-accent-500'"
          class="transition-all duration-500"
        />
      </svg>
      <span
        v-if="contextUsage"
        class="absolute text-[8px] font-bold leading-none"
        :class="contextUsage.percent > 90 ? 'text-red-400' : contextUsage.percent > 70 ? 'text-amber-400' : 'text-theme-400'"
      >{{ Math.round(contextUsage.percent) }}%</span>
    </div>
    <template #content>
      <div
        v-if="contextUsage"
        class="min-w-46"
      >
        <div class="font-medium text-theme-300 mb-1.5">
          Context Window
        </div>
        <div class="flex justify-between text-theme-400 mb-0.5">
          <span>Main Context</span><span class="text-theme-300">{{ contextUsage.used.toLocaleString() }}</span>
        </div>
        <div
          v-if="subAgentUsage"
          class="flex justify-between gap-4 text-theme-400 mb-0.5"
        >
          <span>Sub Agent Usage</span><span class="text-theme-300">{{ subAgentUsage.totalTokens.toLocaleString() }}</span>
        </div>

        <div class="flex justify-between text-theme-400 mb-0.5">
          <span>Capacity</span>
          <span class="flex items-center gap-1.5">
            <span
              v-if="contextUsage.hardLimit"
              class="text-theme-500 line-through"
            >{{ contextUsage.rawMax.toLocaleString() }}</span>
            <span :class="contextUsage.hardLimit ? 'text-amber-300' : 'text-theme-300'">{{ contextUsage.max.toLocaleString() }}</span>
          </span>
        </div>
        <div class="flex justify-between text-theme-400">
          <span>Usage</span>
          <span
            :class="contextUsage.percent > 90 ? 'text-red-400' : contextUsage.percent > 70 ? 'text-amber-400' : 'text-theme-300'"
          >{{ Math.round(contextUsage.percent) }}%</span>
        </div>
        <div class="text-theme-600 text-[10px] mt-1.5 border-t border-theme-800 pt-1.5">
          {{ contextUsage.hardLimit ? 'Capped by agent max context token limit' : 'Tokens used in current conversation' }}
        </div>
      </div>
    </template>
  </HoverTooltip>
</template>
