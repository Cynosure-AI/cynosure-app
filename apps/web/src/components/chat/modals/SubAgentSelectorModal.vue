<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAgentDefinitionsStore } from '../../../stores/agent-definitions.store'
import { useChatStore } from '../../../stores/chat.store'
import { Icon } from '@iconify/vue'
import { useProviderStore } from '../../../stores/provider.store'
import { useProviderLogos } from '../../../composables/useProviderLogos'
import ModalDialog from '../../shared/ModalDialog.vue'

const agentDefs = useAgentDefinitionsStore()
const chatStore = useChatStore()
const providerStore = useProviderStore()
const { logoUrl } = useProviderLogos()

const visible = defineModel<boolean>({ required: true })
const search = ref('')

const agents = computed(() => agentDefs.agents)
const filteredAgents = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return agents.value
  return agents.value.filter(a =>
    a.name.toLowerCase().includes(q) ||
    (a.description && a.description.toLowerCase().includes(q))
  )
})
const selected = computed(() => chatStore.freeChatSubAgentIds)

function toggle(id: string) {
  const idx = chatStore.freeChatSubAgentIds.indexOf(id)
  if (idx >= 0) {
    chatStore.freeChatSubAgentIds.splice(idx, 1)
  } else {
    chatStore.freeChatSubAgentIds.push(id)
  }
  chatStore.markOverridesModified()
}

function agentIcon(agent: { iconUrl: string | null; providerId: string }): string | null {
  if (agent.iconUrl) return agent.iconUrl
  const prov = providerStore.providers.find(p => p.id === agent.providerId)
  return prov ? logoUrl(prov.type) : null
}
</script>

<template>
  <ModalDialog
    :show="visible"
    title="Sub-Agents"
    icon="lucide:bot"
    icon-color="accent"
    max-width="max-w-lg"
    max-height="max-h-[80vh]"
    @close="visible = false"
  >
    <div class="mb-3 flex items-center justify-between gap-4 rounded-lg border border-amber-500/20 bg-amber-500/8 px-3 py-2.5">
      <div class="min-w-0">
        <div class="text-sm text-theme-200">
          Select sub-agents
        </div>
        <div class="text-[11px] text-theme-500">
          Selected sub-agents will be available for the main agent to delegate tasks to during this conversation.
        </div>
      </div>
    </div>
    
    <!-- Search -->
    <div class="sticky top-0 z-10 bg-theme-900 pb-3">
      <input
        v-model="search"
        type="text"
        placeholder="Search agents…"
        class="w-full px-3 py-1.5 text-sm bg-theme-800 border border-theme-700 rounded-lg text-theme-200 placeholder-theme-500 outline-none focus:border-theme-500 transition-colors"
      >
    </div>


    <!-- Agent list -->
    <div class="overflow-y-auto space-y-1 max-h-[calc(80vh-120px)]">
      <div
        v-if="filteredAgents.length === 0"
        class="text-sm text-theme-500 text-center py-6"
      >
        {{ search ? 'No matching agents' : 'No agents created yet' }}
      </div>
      <button
        v-for="agent in filteredAgents"
        :key="agent.id"
        class="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg transition-colors text-left"
        :class="selected.includes(agent.id)
          ? 'bg-accent-600/15 border border-accent-500/30'
          : 'hover:bg-theme-800 border border-transparent'"
        @click="toggle(agent.id)"
      >
        <div class="w-7 h-7 rounded-lg bg-theme-800 flex items-center justify-center shrink-0 overflow-hidden">
          <img
            v-if="agentIcon(agent)"
            :src="agentIcon(agent)!"
            class="w-full h-full object-contain"
          >
          <Icon
            v-else
            icon="lucide:bot"
            class="w-3.5 h-3.5 text-theme-500"
          />
        </div>
        <div
          class="flex-1 min-w-0"
          :title="agent.internalName ? `Internal Name: ${agent.internalName}` : undefined"
        >
          <div
            class="text-sm text-theme-200 truncate"
          >
            {{ agent.name }}
          </div>
          <div
            v-if="agent.description"
            class="text-[11px] text-theme-500 truncate"
          >
            {{ agent.description }}
          </div>
        </div>
        <Icon
          v-if="selected.includes(agent.id)"
          icon="mdi:check-circle"
          class="w-4 h-4 text-accent-400 shrink-0"
        />
      </button>
    </div>
  </ModalDialog>
</template>
