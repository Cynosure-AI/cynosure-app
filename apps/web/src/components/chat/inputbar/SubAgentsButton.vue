<script setup lang="ts">
import { ref, computed } from 'vue'
import { useChatStore } from '../../../stores/chat.store'
import { useAgentDefinitionsStore } from '../../../stores/agent-definitions.store'
import { Icon } from '@iconify/vue'
import HoverTooltip from '../../shared/HoverTooltip.vue'
import SubAgentSelectorModal from '../modals/SubAgentSelectorModal.vue'

const chatStore = useChatStore()
const agentDefs = useAgentDefinitionsStore()

const showModal = ref(false)

const subAgentCount = computed(() =>
  chatStore.freeChatSubAgentIds.length
)

const selectedSubAgents = computed(() => {
  const ids = chatStore.freeChatSubAgentIds
  return agentDefs.agents.filter(a => ids.includes(a.id))
})

const missingSubAgents = computed(() =>
  chatStore.freeChatSubAgentIds.filter(id => !agentDefs.get(id))
)

const applyToAllStateLabel = computed(() =>
  chatStore.sessionOverrideSubAgents ? 'Enforce model enabled' : 'Enforce model disabled'
)
</script>

<template>
  <HoverTooltip
    v-if="agentDefs.agents.length"
    :max-width="260"
  >
    <button
      class="relative p-2.5 rounded-xl transition-colors shrink-0 focus:outline-none focus:ring-1 focus:ring-accent-500 text-theme-500 hover:text-theme-300"
      aria-label="Sub-agents"
      @click="showModal = true"
    >
      <Icon
        icon="lucide:bot"
        class="h-5 w-5"
      />
      <span
        v-if="missingSubAgents.length"
        class="absolute -top-0.5 text-black -right-0.5 min-w-4 h-4 flex items-center justify-center rounded-full text-[9px] font-bold px-1 leading-none bg-amber-500"
      >
        <Icon
          icon="lucide:alert-triangle"
          class="w-2.5 h-2.5"
        />
      </span>
      <span
        v-else-if="subAgentCount > 0"
        class="absolute -top-0.5 -right-0.5 min-w-4 h-4 flex items-center justify-center rounded-full text-[9px] font-bold text-white px-1 leading-none bg-accent-600"
      >
        {{ subAgentCount }}
      </span>
    </button>
    <template #content>
      <div class="font-medium text-theme-300 mb-1.5">
        Sub-Agents ({{ subAgentCount }} selected)
      </div>
      <div
        class="mb-1.5 px-1 py-1 rounded border text-[10px]"
        :class="chatStore.sessionOverrideSubAgents
          ? 'bg-amber-500/10 border-amber-500/20 text-amber-300'
          : 'bg-theme-800/80 border-theme-700 text-theme-400'"
      >
        {{ applyToAllStateLabel }}
      </div>
      <template v-if="missingSubAgents.length">
        <div class="mb-1.5 px-1 py-1 rounded bg-amber-500/10 border border-amber-500/20">
          <div class="flex items-center gap-1 text-amber-400 text-[10px] font-medium mb-1">
            <Icon
              icon="lucide:alert-triangle"
              class="w-3 h-3 shrink-0"
            />
            {{ missingSubAgents.length }} sub-agent{{ missingSubAgents.length > 1 ? 's' : '' }} unavailable
          </div>
          <div
            v-for="id in missingSubAgents.slice(0, 5)"
            :key="id"
            class="text-amber-300/70 font-mono text-[10px] truncate pl-4"
          >
            {{ id }}
          </div>
          <div
            v-if="missingSubAgents.length > 5"
            class="text-amber-400/50 text-[9px] pl-4"
          >
            +{{ missingSubAgents.length - 5 }} more
          </div>
        </div>
      </template>
      <template v-if="selectedSubAgents.length">
        <div
          v-for="a in selectedSubAgents.slice(0, 9)"
          :key="a.id"
          class="flex items-start gap-1.5 mb-1 last:mb-0"
        >
          <img
            v-if="a.iconUrl"
            :src="a.iconUrl"
            :alt="a.name"
            class="w-3 h-3 rounded-sm shrink-0 mt-0.5 object-cover"
          >
          <Icon
            v-else
            icon="lucide:bot"
            class="w-3 h-3 text-accent-400 shrink-0 mt-0.5"
          />
          <div class="min-w-0">
            <div class="text-theme-300 text-[11px] truncate">
              {{ a.name }}
            </div>
            <div
              v-if="a.description"
              class="text-theme-500 text-[10px] truncate"
            >
              {{ a.description }}
            </div>
          </div>
        </div>
        <div
          v-if="selectedSubAgents.length > 9"
          class="text-theme-500 text-[10px] mt-1"
        >
          +{{ selectedSubAgents.length - 9 }} more
        </div>
      </template>
      <div
        v-else
        class="text-theme-500"
      >
        No sub-agents selected
      </div>
      <div class="text-theme-600 text-[10px] mt-1.5 border-t border-theme-800 pt-1.5">
        Click to configure
      </div>
    </template>
  </HoverTooltip>

  <SubAgentSelectorModal v-model="showModal" />
</template>
