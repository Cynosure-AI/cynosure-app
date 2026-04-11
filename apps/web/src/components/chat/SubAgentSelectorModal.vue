<script setup lang="ts">
import { computed } from 'vue'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import { useChatStore } from '../../stores/chat.store'
import { Icon } from '@iconify/vue'
import { useProviderStore } from '../../stores/provider.store'
import { useProviderLogos } from '../../composables/useProviderLogos'

const agentDefs = useAgentDefinitionsStore()
const chatStore = useChatStore()
const providerStore = useProviderStore()
const { logoUrl } = useProviderLogos()

const visible = defineModel<boolean>({ required: true })

const agents = computed(() => agentDefs.agents)
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

function toCodename(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
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
            Sub-Agents
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

        <!-- Agent list -->
        <div class="overflow-y-auto p-2 space-y-1">
          <div
            v-if="agents.length === 0"
            class="text-sm text-zinc-500 text-center py-6"
          >
            No agents created yet
          </div>
          <button
            v-for="agent in agents"
            :key="agent.id"
            class="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg transition-colors text-left"
            :class="selected.includes(agent.id)
              ? 'bg-blue-600/15 border border-blue-500/30'
              : 'hover:bg-zinc-800 border border-transparent'"
            @click="toggle(agent.id)"
          >
            <div class="w-7 h-7 rounded-lg bg-zinc-800 flex items-center justify-center shrink-0 overflow-hidden">
              <img
                v-if="agentIcon(agent)"
                :src="agentIcon(agent)!"
                class="w-full h-full object-contain"
              >
              <Icon
                v-else
                icon="lucide:bot"
                class="w-3.5 h-3.5 text-zinc-500"
              />
            </div>
            <div
              class="flex-1 min-w-0"
              :title="toCodename(agent.name) ? `Internal Codename: ${toCodename(agent.name)}` : undefined"
            >
              <div
                class="text-sm text-zinc-200 truncate"
              >
                {{ agent.name }}
              </div>
              <div
                v-if="agent.description"
                class="text-[11px] text-zinc-500 truncate"
              >
                {{ agent.description }}
              </div>
            </div>
            <Icon
              v-if="selected.includes(agent.id)"
              icon="mdi:check-circle"
              class="w-4 h-4 text-blue-400 shrink-0"
            />
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
