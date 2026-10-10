<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import type { Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { useAgentHealthStore } from '../stores/agent-health.store'
import { useChatStore } from '../stores/chat.store'
import { Icon } from '@iconify/vue'
import type { AgentDefinition } from '../api/types'
import AgentGeneralTab from '../components/agent/AgentGeneralTab.vue'
import AgentToolsTab from '../components/agent/AgentToolsTab.vue'
import AgentMemoryTab from '../components/agent/AgentMemoryTab.vue'
import AgentSubAgentsTab from '../components/agent/AgentSubAgentsTab.vue'
import AgentAdvancedTab from '../components/agent/AgentAdvancedTab.vue'
import TabBar, { type TabDef } from '../components/shared/TabBar.vue'

type AgentSectionId = 'general' | 'tools' | 'sub-agents' | 'memory' | 'advanced'

interface AgentSection {
  id: AgentSectionId
  label: string
  description: string
  icon: string
  component: Component
}

const route = useRoute()
const router = useRouter()
const agentDefs = useAgentDefinitionsStore()
const agentHealth = useAgentHealthStore()
const chatStore = useChatStore()

const activeSectionId = ref<AgentSectionId>('general')

const agentId = computed(() => route.params.id as string)
const agent = computed(() => agentDefs.get(agentId.value))
const activeSection = computed(() => sections.find(section => section.id === activeSectionId.value) || sections[0])
const returnToChat = computed(() => {
  const target = route.query.returnTo
  if (typeof target !== 'string' || !target.startsWith('/chat')) return null
  const destination = router.resolve(target)
  return destination.name === 'triggers-chat' || destination.name === 'conversation'
    ? target
    : null
})

function goBack(): void {
  void router.push(returnToChat.value ?? '/agents')
}

onMounted(async () => {
  void agentHealth.loadMemoryFolders()
  await agentDefs.load()
  if (!agent.value) {
    router.push('/agents')
  }
})

async function updateField(field: string, value: unknown) {
  if (agent.value) {
    await agentDefs.update(agentId.value, { [field]: value })
  }
}

async function updateReasoning(enabled: boolean, effort: AgentDefinition['reasoningEffort']) {
  if (agent.value) {
    await agentDefs.update(agentId.value, { thinkingEnabled: enabled, reasoningEffort: effort })
  }
}

async function goToChat() {
  await chatStore.setActiveAgent(agentId.value)
  await router.push({ name: 'triggers-chat' })
}

const sections: AgentSection[] = [
  {
    id: 'general',
    label: 'General',
    description: 'Edit the agent identity, instructions, model, and core behavior.',
    icon: 'lucide:settings',
    component: AgentGeneralTab
  },
  {
    id: 'tools',
    label: 'Tools',
    description: 'Choose which tools this agent can use during conversations.',
    icon: 'lucide:wrench',
    component: AgentToolsTab
  },
  {
    id: 'memory',
    label: 'Memory',
    description: 'Control memory folders and retrieval behavior for this agent.',
    icon: 'lucide:database',
    component: AgentMemoryTab
  },
  {
    id: 'sub-agents',
    label: 'Sub-Agents',
    description: 'Configure delegated agents and collaboration behavior.',
    icon: 'lucide:users',
    component: AgentSubAgentsTab
  },
  {
    id: 'advanced',
    label: 'Advanced',
    description: 'Tune advanced execution, approval, and automation settings.',
    icon: 'lucide:sliders-horizontal',
    component: AgentAdvancedTab
  }
]

const health = computed(() => agent.value ? agentHealth.validate(agent.value) : null)
const missingTools = computed(() => health.value?.tools ?? [])
const missingMemoryFolders = computed(() => health.value?.memoryFolders ?? [])
const missingSubAgents = computed(() => health.value?.subAgents ?? [])

const tabs = computed<TabDef<AgentSectionId>[]>(() => {
  const warnings: Partial<Record<AgentSectionId, string>> = {
    tools: missingTools.value.length ? `Unavailable tools: ${missingTools.value.join(', ')}` : '',
    memory: missingMemoryFolders.value.length ? `Unavailable memory folders: ${missingMemoryFolders.value.join(', ')}` : '',
    'sub-agents': missingSubAgents.value.length ? `Unavailable sub-agents: ${missingSubAgents.value.join(', ')}` : '',
  }
  return sections.map(section => ({
    value: section.id,
    label: section.label,
    icon: section.icon,
    warning: warnings[section.id],
  }))
})


</script>

<template>
  <div
    v-if="agent"
    class="h-full overflow-y-auto"
  >
    <header class="page-header relative z-20 border-b border-theme-800/60 bg-theme-950/95 pt-4 backdrop-blur-sm sm:sticky sm:top-0 sm:pt-5">
      <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div class="flex items-start justify-between gap-3">
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-ink-muted transition-colors hover:bg-theme-800 hover:text-theme-300"
            :aria-label="returnToChat ? 'Back to chat' : 'Back to agents'"
            @click="goBack"
          >
            <Icon
              icon="lucide:arrow-left"
              class="h-4 w-4"
            />
            <span>{{ returnToChat ? 'Chat' : 'Agents' }}</span>
          </button>

          <button
            type="button"
            class="inline-flex shrink-0 items-center gap-2 rounded-lg accent-action bg-accent-500 px-3 py-2 text-sm font-semibold text-accent-on transition-colors hover:bg-accent-400"
            @click="goToChat"
          >
            <Icon
              icon="lucide:message-circle"
              class="h-4 w-4"
            />
            <span>Go to chat</span>
          </button>
        </div>

        <div class="mt-2 flex min-w-0 items-center gap-3">
          <div
            class="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-linear-to-br from-accent-500/20 to-purple-500/20"
          >
            <img
              v-if="agent.iconUrl"
              :src="agent.iconUrl"
              alt=""
              class="h-full w-full object-cover"
            >
            <Icon
              v-else
              icon="lucide:bot"
              class="h-6 w-6 text-accent-fg"
            />
          </div>
          <div class="min-w-0">
            <h1 class="break-words text-2xl font-bold leading-tight text-theme-100">
              {{ agent.name }}
            </h1>
            <p
              v-if="agent.description"
              class="mt-1 line-clamp-2 text-sm leading-relaxed text-ink-muted"
            >
              {{ agent.description }}
            </p>
          </div>
        </div>

  

        <TabBar
          v-model="activeSectionId"
          :tabs="tabs"
          class="mt-4"
        />
      </div>
    </header>

    <main class="min-w-0">
      <div class="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <section class="scroll-mt-4">
          <div class="mb-5 flex items-start gap-3">
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-theme-900 text-ink-secondary ring-1 ring-theme-800">
              <Icon
                :icon="activeSection.icon"
                class="h-5 w-5"
              />
            </div>
            <div class="min-w-0">
              <h2 class="text-xl font-bold text-theme-100">
                {{ activeSection.label }}
              </h2>
              <p class="mt-1 text-sm leading-relaxed text-ink-muted">
                {{ activeSection.description }}
              </p>
            </div>
          </div>

          <component
            :is="activeSection.component"
            :agent="agent"
            @update="updateField"
            @update-reasoning="updateReasoning"
          />
        </section>
      </div>
    </main>
  </div>
</template>
