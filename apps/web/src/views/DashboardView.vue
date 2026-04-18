<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useProviderStore } from '../stores/provider.store'
import { useAgentDefinitionsStore, type AgentDefinition } from '../stores/agent-definitions.store'
import { useChatStore } from '../stores/chat.store'
import { useProviderLogos } from '../composables/useProviderLogos'
import { useRouter } from 'vue-router'
import { api } from '../api/client'
import { wsConnected } from '../api/http'
import { Icon } from '@iconify/vue'
import AgentCarousel from '../components/dashboard/AgentCarousel.vue'

const providerStore = useProviderStore()
const agentDefs = useAgentDefinitionsStore()
const chatStore = useChatStore()
const router = useRouter()
const { logoUrl } = useProviderLogos()

const carouselAgents = computed(() => agentDefs.agents.filter(a => a.showInCarousel !== false))

interface RecentConversation {
  id: string
  title: string
  agent_id: string | null
  updated_at: number
  last_user_message: string | null
}

const recentConvos = ref<RecentConversation[]>([])

onMounted(async () => {
  agentDefs.load()
  try {
    const all = await api.chat.listConversations()
    recentConvos.value = all.slice(0, 8)
  } catch { /* ignore */ }
})

async function startChat(agent: AgentDefinition): Promise<void> {
  await chatStore.setActiveAgent(agent.id)
  router.push('/triggers/chat')
}

async function openConversation(convo: RecentConversation): Promise<void> {
  await chatStore.setActiveAgent(convo.agent_id)
  if (convo.id) {
    await chatStore.selectConversation(convo.id)
  }
  router.push('/triggers/chat')
}

function agentIcon(agentId: string | null): string | null {
  if (!agentId) return null
  const def = agentDefs.agents.find(a => a.id === agentId)
  if (!def) return null
  if (def.iconUrl) return def.iconUrl
  const prov = providerStore.providers.find(p => p.id === def.providerId)
  return prov ? logoUrl(prov.type) : null
}

function agentName(agentId: string | null): string {
  if (!agentId) return 'Default'
  return agentDefs.agents.find(a => a.id === agentId)?.name ?? 'Unknown'
}

function timeLabel(ts: number): string {
  const now = Date.now()
  const diff = now - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const quickActions = [
  { label: 'New Chat', icon: 'lucide:message-square-plus', route: '/triggers/chat' },
  { label: 'Create Agent', icon: 'lucide:bot', route: '/agents' },
  { label: 'Add Provider', icon: 'lucide:plus-circle', route: '/settings/providers' },
  { label: 'Manage MCPs', icon: 'lucide:plug', route: '/settings/mcp' }
]

function navigate(route: string) {
  router.push(route)
}
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-5xl mx-auto py-8 px-6">
      <!-- Header -->
      <div class="mb-8">
        <h1 class="text-2xl font-bold text-zinc-100">
          Dashboard
        </h1>
        <p class="text-sm text-zinc-500 mt-1">
          Quick actions and system overview
        </p>
      </div>

      <!-- Initializing banner (server not yet ready) -->
      <div
        v-if="!wsConnected"
        class="mb-8 rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 flex flex-col items-center justify-center gap-3"
      >
        <Icon
          icon="lucide:loader-2"
          class="w-8 h-8 text-blue-400 animate-spin"
        />
        <p class="text-sm text-zinc-300 font-medium">
          Initializing server…
        </p>
        <p class="text-xs text-zinc-500">
          Loading MCPs and preparing your workspace
        </p>
      </div>

      <!-- Agent Carousel -->
      <div
        v-if="carouselAgents.length"
        class="mb-8"
      >
        <h2 class="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-3">
          Your Agents
        </h2>
        <div class="rounded-xl border border-zinc-800 bg-zinc-900/50 py-4 overflow-hidden">
          <AgentCarousel
            :agents="carouselAgents"
            @select="startChat"
          />
        </div>
      </div>

      <!-- Quick Actions -->
      <div class="mb-8">
        <h2 class="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-3">
          Quick Actions
        </h2>
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <button
            v-for="action in quickActions"
            :key="action.label"
            class="flex items-center gap-3 p-4 rounded-xl border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-800/80 hover:border-zinc-700 transition-all text-left group"
            @click="navigate(action.route)"
          >
            <Icon
              :icon="action.icon"
              class="w-5 h-5 text-zinc-500 group-hover:text-blue-400 transition-colors"
            />
            <span
              class="text-sm text-zinc-300 group-hover:text-zinc-100 transition-colors"
            >{{ action.label }}</span>
          </button>
        </div>
      </div>

      <!-- Recent Conversations -->
      <div v-if="recentConvos.length">
        <h2 class="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-3">
          Recent Conversations
        </h2>
        <div class="rounded-xl border border-zinc-800 bg-zinc-900/50 divide-y divide-zinc-800">
          <button
            v-for="convo in recentConvos"
            :key="convo.id"
            class="flex items-center gap-3 p-3 w-full text-left hover:bg-zinc-800/60 transition-colors group"
            @click="openConversation(convo)"
          >
            <!-- Agent icon -->
            <div class="w-8 h-8 rounded-lg bg-zinc-800 flex items-center justify-center shrink-0 overflow-hidden">
              <img
                v-if="agentIcon(convo.agent_id)"
                :src="agentIcon(convo.agent_id)!"
                class="w-full h-full object-contain"
              >
              <Icon
                v-else
                icon="lucide:bot"
                class="w-4 h-4 text-zinc-500"
              />
            </div>

            <!-- Content -->
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-sm text-zinc-200 truncate group-hover:text-zinc-100">{{ convo.title || 'New Chat' }}</span>
                <span class="text-[10px] text-zinc-600 shrink-0 ml-auto">{{ timeLabel(convo.updated_at) }}</span>
              </div>
              <div class="flex items-center gap-1.5 mt-0.5">
                <span class="text-[11px] text-zinc-500">{{ agentName(convo.agent_id) }}</span>
              </div>
              <p
                v-if="convo.last_user_message"
                class="text-[11px] text-zinc-600 truncate mt-0.5"
              >
                {{ convo.last_user_message }}
              </p>
            </div>

            <Icon
              icon="lucide:chevron-right"
              class="w-3.5 h-3.5 text-zinc-700 group-hover:text-zinc-500 shrink-0 transition-colors"
            />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
