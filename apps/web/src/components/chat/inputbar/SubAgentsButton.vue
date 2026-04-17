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
</script>

<template>
  <HoverTooltip
    v-if="agentDefs.agents.length"
    :max-width="260"
  >
    <button
      class="relative p-2.5 rounded-xl transition-colors shrink-0 focus:outline-none focus:ring-1 focus:ring-blue-500 text-zinc-500 hover:text-zinc-300"
      aria-label="Sub-agents"
      @click="showModal = true"
    >
      <Icon
        icon="lucide:bot"
        class="h-5 w-5"
      />
      <span
        v-if="subAgentCount > 0"
        class="absolute -top-0.5 -right-0.5 min-w-4 h-4 flex items-center justify-center rounded-full text-[9px] font-bold text-white px-1 leading-none bg-blue-600"
      >
        {{ subAgentCount }}
      </span>
    </button>
    <template #content>
      <div class="font-medium text-zinc-300 mb-1.5">
        Sub-Agents ({{ subAgentCount }} selected)
      </div>
      <template v-if="selectedSubAgents.length">
        <div
          v-for="a in selectedSubAgents.slice(0, 6)"
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
            class="w-3 h-3 text-blue-400 shrink-0 mt-0.5"
          />
          <div class="min-w-0">
            <div class="text-zinc-300 text-[11px] truncate">
              {{ a.name }}
            </div>
            <div
              v-if="a.description"
              class="text-zinc-500 text-[10px] truncate"
            >
              {{ a.description }}
            </div>
          </div>
        </div>
        <div
          v-if="selectedSubAgents.length > 6"
          class="text-zinc-500 text-[10px] mt-1"
        >
          +{{ selectedSubAgents.length - 6 }} more
        </div>
      </template>
      <div
        v-else
        class="text-zinc-500"
      >
        No sub-agents selected
      </div>
      <div class="text-zinc-600 text-[10px] mt-1.5 border-t border-zinc-800 pt-1.5">
        Click to configure
      </div>
    </template>
  </HoverTooltip>

  <SubAgentSelectorModal v-model="showModal" />
</template>
