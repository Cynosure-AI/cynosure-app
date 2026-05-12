<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { Icon } from '@iconify/vue'
import AgentGeneralTab from '../components/agent/AgentGeneralTab.vue'
import AgentToolsTab from '../components/agent/AgentToolsTab.vue'
import AgentMemoryTab from '../components/agent/AgentMemoryTab.vue'
import AgentSubAgentsTab from '../components/agent/AgentSubAgentsTab.vue'
import AgentAdvancedTab from '../components/agent/AgentAdvancedTab.vue'

const route = useRoute()
const router = useRouter()
const agentDefs = useAgentDefinitionsStore()

const activeTab = ref('general')

const agentId = computed(() => route.params.id as string)
const agent = computed(() => agentDefs.get(agentId.value))

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

const tabs = [
  { id: 'general', label: 'General', icon: 'lucide:settings' },
  { id: 'tools', label: 'Tools', icon: 'lucide:wrench' },
  { id: 'sub-agents', label: 'Sub-Agents', icon: 'lucide:users' },
  { id: 'memory', label: 'Memory', icon: 'lucide:brain' },
  { id: 'advanced', label: 'Advanced', icon: 'lucide:sliders-horizontal' }
]
</script>

<template>
  <div
    v-if="agent"
    class="h-full overflow-y-auto"
  >
    <div class="max-w-3xl mx-auto py-8 px-6">
      <!-- Back + Title -->
      <div class="flex items-center gap-3 mb-6">
        <button
          class="p-1.5 text-theme-500 hover:text-theme-300 transition-colors"
          @click="router.push('/agents')"
        >
          <Icon
            icon="lucide:arrow-left"
            class="w-5 h-5"
          />
        </button>
        <div
          class="w-9 h-9 rounded-lg bg-linear-to-br from-accent-500/20 to-purple-500/20 flex items-center justify-center overflow-hidden shrink-0"
        >
          <img
            v-if="agent.iconUrl"
            :src="agent.iconUrl"
            alt=""
            class="w-full h-full object-cover"
          >
          <Icon
            v-else
            icon="lucide:bot"
            class="w-5 h-5 text-accent-400"
          />
        </div>
        <div>
          <h1 class="text-2xl font-bold text-theme-100">
            {{ agent.name }}
          </h1>
          <p
            v-if="agent.description"
            class="text-sm text-theme-500 mt-0.5"
          >
            {{ agent.description }}
          </p>
        </div>
      </div>

      <!-- Tabs -->
      <div class="w-full overflow-x-auto overflow-y-hidden mb-6 border-b border-theme-800">
        <div class="flex gap-1 whitespace-nowrap min-w-max items-center">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            class="flex items-center gap-2 px-4 py-2 text-sm transition-colors border-b-2 -mb-px flex-shrink-0"
            :class="
              activeTab === tab.id
                ? 'text-accent-400 border-accent-400'
                : 'text-theme-500 border-transparent hover:text-theme-300'
            "
            @click="activeTab = tab.id"
          >
            <Icon
              :icon="tab.icon"
              class="w-4 h-4"
            />
            {{ tab.label }}
          </button>
        </div>
      </div>

      <!-- General Tab -->
      <AgentGeneralTab
        v-if="activeTab === 'general'"
        :agent="agent"
        @update="updateField"
      />

      <!-- Tools Tab -->
      <AgentToolsTab
        v-if="activeTab === 'tools'"
        :agent="agent"
        @update="updateField"
      />

      <!-- Memory Tab -->
      <AgentMemoryTab
        v-if="activeTab === 'memory'"
        :agent="agent"
        @update="updateField"
      />

      <!-- Sub-Agents Tab -->
      <AgentSubAgentsTab
        v-if="activeTab === 'sub-agents'"
        :agent="agent"
        @update="updateField"
      />

      <!-- Advanced Tab -->
      <AgentAdvancedTab
        v-if="activeTab === 'advanced'"
        :agent="agent"
        @update="updateField"
      />
    </div>
  </div>
</template>
