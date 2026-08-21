<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import type { Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { useChatStore } from '../stores/chat.store'
import { Icon } from '@iconify/vue'
import AgentGeneralTab from '../components/agent/AgentGeneralTab.vue'
import AgentToolsTab from '../components/agent/AgentToolsTab.vue'
import AgentMemoryTab from '../components/agent/AgentMemoryTab.vue'
import AgentSubAgentsTab from '../components/agent/AgentSubAgentsTab.vue'
import AgentAdvancedTab from '../components/agent/AgentAdvancedTab.vue'

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
const chatStore = useChatStore()

const activeSectionId = ref<AgentSectionId>('general')

const agentId = computed(() => route.params.id as string)
const agent = computed(() => agentDefs.get(agentId.value))
const activeSection = computed(() => sections.find(section => section.id === activeSectionId.value) || sections[0])

onMounted(async () => {
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
    description: 'Control memory spaces and retrieval behavior for this agent.',
    icon: 'lucide:brain',
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

function sectionButtonClass(id: AgentSectionId): string {
  return activeSectionId.value === id
    ? 'bg-theme-800 text-theme-100 shadow-[inset_3px_0_0_var(--color-accent-500,#3b82f6)]'
    : 'text-theme-400 hover:bg-theme-800/70 hover:text-theme-200'
}
</script>

<template>
  <div
    v-if="agent"
    class="h-full overflow-hidden"
  >
    <div class="flex h-full flex-col lg:flex-row">
      <aside class="shrink-0 border-b border-theme-800 bg-theme-950/60 lg:w-72 lg:border-b-0 lg:border-r">
        <header class="p-4">
          <button
            class="mb-4 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-theme-500 transition-colors hover:bg-theme-800 hover:text-theme-300"
            aria-label="Back to agents"
            @click="router.push('/agents')"
          >
            <Icon
              icon="lucide:arrow-left"
              class="h-4 w-4"
            />
            <span>Back</span>
          </button>
          <div class="flex items-center gap-3">
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
                class="h-6 w-6 text-accent-400"
              />
            </div>
            <h1 class="break-words text-xl font-bold leading-tight text-theme-100">
              {{ agent.name }}
            </h1>
          </div>
          <p
            v-if="agent.description"
            class="mt-3 text-sm leading-relaxed text-theme-500"
          >
            {{ agent.description }}
          </p>
          <div class="mt-4 flex flex-wrap gap-2">
            <span
              class="inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-medium"
              :class="agent.autoToolRouting
                ? 'border-accent-500/25 bg-accent-500/10 text-accent-300'
                : 'border-theme-700 bg-theme-900/70 text-theme-500'"
              :title="`Automatic tool selection is ${agent.autoToolRouting ? 'enabled' : 'disabled'}`"
            >
              <Icon
                icon="lucide:wrench"
                class="h-3 w-3"
              />
              Auto tools: {{ agent.autoToolRouting ? 'On' : 'Off' }}
            </span>
            <span
              class="inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-medium"
              :class="agent.autoMemory
                ? 'border-accent-500/25 bg-accent-500/10 text-accent-300'
                : 'border-theme-700 bg-theme-900/70 text-theme-500'"
              :title="`Automatic memory retrieval is ${agent.autoMemory ? 'enabled' : 'disabled'}`"
            >
              <Icon
                icon="lucide:brain"
                class="h-3 w-3"
              />
              Auto memory: {{ agent.autoMemory ? 'On' : 'Off' }}
            </span>
          </div>
        </header>

        <nav class="flex gap-1 overflow-x-auto px-3 py-3 lg:block lg:space-y-1 lg:overflow-x-visible lg:p-4">
          <button
            v-for="section in sections"
            :key="section.id"
            class="flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition-all lg:w-full"
            :class="sectionButtonClass(section.id)"
            @click="activeSectionId = section.id"
          >
            <Icon
              :icon="section.icon"
              class="h-4.5 w-4.5 shrink-0"
            />
            <span class="whitespace-nowrap">{{ section.label }}</span>
          </button>
        </nav>
      </aside>

      <main class="min-w-0 flex-1 overflow-y-auto">
        <div class="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
          <section class="scroll-mt-4">
            <div class="mb-5 flex items-start gap-3">
              <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-theme-900 text-theme-400 ring-1 ring-theme-800">
                <Icon
                  :icon="activeSection.icon"
                  class="h-5 w-5"
                />
              </div>
              <div class="min-w-0">
                <h2 class="text-xl font-bold text-theme-100">
                  {{ activeSection.label }}
                </h2>
                <p class="mt-1 text-sm leading-relaxed text-theme-500">
                  {{ activeSection.description }}
                </p>
              </div>
              <button
                class="ml-auto inline-flex shrink-0 items-center gap-2 rounded-lg bg-accent-500 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-400"
                @click="goToChat"
              >
                <Icon
                  icon="lucide:message-circle"
                  class="h-4 w-4"
                />
                <span class="hidden sm:inline">Go to chat</span>
              </button>
            </div>

            <component
              :is="activeSection.component"
              :agent="agent"
              @update="updateField"
            />
          </section>
        </div>
      </main>
    </div>
  </div>
</template>
