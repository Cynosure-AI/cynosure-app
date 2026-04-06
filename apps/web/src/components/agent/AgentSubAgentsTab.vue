<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import type { AgentDefinition, SubAgentAssignment } from '../../api/client'
import { Icon } from '@iconify/vue'

const props = defineProps<{ agent: AgentDefinition }>()
const emit = defineEmits<{ update: [field: string, value: unknown] }>()

const agentDefs = useAgentDefinitionsStore()

const showAddDialog = ref(false)
const addAgentId = ref('')
const addCodename = ref('')
const addRole = ref('')

const availableAgents = computed(() => {
  const assignedIds = new Set((props.agent.subAgents || []).map(sa => sa.agentId))
  assignedIds.add(props.agent.id) // exclude self
  return agentDefs.agents.filter(a => !assignedIds.has(a.id))
})

function toCodename(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

watch(addAgentId, (newId) => {
  if (newId) {
    const agent = agentDefs.get(newId)
    if (agent) {
      addCodename.value = toCodename(agent.name)
      addRole.value = agent.description || ''
    }
  }
})

function addSubAgent() {
  if (!addAgentId.value || !addCodename.value.trim()) return
  const newAssignment: SubAgentAssignment = {
    agentId: addAgentId.value,
    codename: addCodename.value.trim(),
    role: addRole.value.trim(),
  }
  emit('update', 'subAgents', [...(props.agent.subAgents || []), newAssignment])
  showAddDialog.value = false
  addAgentId.value = ''
  addCodename.value = ''
  addRole.value = ''
}

function removeSubAgent(agentId: string) {
  emit('update', 'subAgents', (props.agent.subAgents || []).filter(sa => sa.agentId !== agentId))
}

function updateSubAgentCodename(agentId: string, codename: string) {
  const updated = (props.agent.subAgents || []).map(sa =>
    sa.agentId === agentId ? { ...sa, codename } : sa
  )
  emit('update', 'subAgents', updated)
}

function updateSubAgentRole(agentId: string, role: string) {
  const updated = (props.agent.subAgents || []).map(sa =>
    sa.agentId === agentId ? { ...sa, role } : sa
  )
  emit('update', 'subAgents', updated)
}

function getAgentName(id: string): string {
  return agentDefs.get(id)?.name || 'Unknown Agent'
}

function getAgentIcon(id: string): string | null {
  return agentDefs.get(id)?.iconUrl || null
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between mb-2">
      <div>
        <p class="text-sm text-zinc-400">
          Assign sub-agents for multi-agent orchestration.
        </p>
        <p class="text-xs text-zinc-600 mt-1">
          When sub-agents are assigned, the agent acts as orchestrator — planning tasks and delegating to sub-agents by codename.
        </p>
      </div>
      <button
        class="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-medium transition-colors"
        @click="showAddDialog = true"
      >
        <Icon
          icon="lucide:plus"
          class="w-3.5 h-3.5"
        />
        Add Sub-Agent
      </button>
    </div>

    <!-- Sub-agents list -->
    <div
      v-if="(agent.subAgents || []).length"
      class="space-y-3"
    >
      <div
        v-for="sa in agent.subAgents"
        :key="sa.agentId"
        class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4"
      >
        <div class="flex items-start justify-between mb-3">
          <div class="flex items-center gap-3">
            <div
              class="w-8 h-8 rounded-lg bg-linear-to-br from-blue-500/20 to-purple-500/20 flex items-center justify-center overflow-hidden"
            >
              <img
                v-if="getAgentIcon(sa.agentId)"
                :src="getAgentIcon(sa.agentId)!"
                alt=""
                class="w-full h-full object-cover"
              >
              <Icon
                v-else
                icon="lucide:bot"
                class="w-4 h-4 text-blue-400"
              />
            </div>
            <div>
              <span class="text-sm font-medium text-zinc-200">{{ getAgentName(sa.agentId) }}</span>
              <span class="ml-2 text-xs text-violet-400/80 bg-violet-400/10 px-1.5 py-0.5 rounded font-mono">{{ sa.codename }}</span>
            </div>
          </div>
          <button
            class="p-1.5 text-zinc-500 hover:text-red-400 rounded-md transition-all"
            @click="removeSubAgent(sa.agentId)"
          >
            <Icon
              icon="lucide:trash-2"
              class="w-4 h-4"
            />
          </button>
        </div>

        <div class="grid grid-cols-2 gap-3 ml-11">
          <div>
            <label class="block text-xs text-zinc-500 mb-1">Codename</label>
            <input
              :value="sa.codename"
              type="text"
              class="w-full px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-zinc-200 font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
              @change="updateSubAgentCodename(sa.agentId, ($event.target as HTMLInputElement).value)"
            >
          </div>
          <div>
            <label class="block text-xs text-zinc-500 mb-1">Role</label>
            <input
              :value="sa.role"
              type="text"
              placeholder="What this agent specializes in"
              class="w-full px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
              @change="updateSubAgentRole(sa.agentId, ($event.target as HTMLInputElement).value)"
            >
          </div>
        </div>
      </div>
    </div>

    <!-- Empty state -->
    <div
      v-else
      class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-8 text-center"
    >
      <Icon
        icon="lucide:users"
        class="w-8 h-8 text-zinc-600 mx-auto mb-3"
      />
      <p class="text-sm text-zinc-500 mb-1">
        No sub-agents assigned
      </p>
      <p class="text-xs text-zinc-600 max-w-sm mx-auto">
        Add agents from your library and assign them codenames. The orchestrator will plan tasks and delegate to sub-agents automatically.
      </p>
    </div>

    <!-- How it works -->
    <div class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h3 class="text-sm font-medium text-zinc-300 mb-2 flex items-center gap-2">
        <Icon
          icon="lucide:info"
          class="w-4 h-4 text-blue-400"
        />
        How Sub-Agent Orchestration Works
      </h3>
      <ol class="text-xs text-zinc-500 space-y-1.5 ml-6 list-decimal">
        <li>When you chat with this agent, it receives the task and creates a <strong class="text-zinc-400">plan</strong></li>
        <li>For each step, it creates <strong class="text-zinc-400">instructions</strong> and invokes the assigned sub-agent</li>
        <li>Sub-agents execute their specialized tasks and report results</li>
        <li>If a sub-agent encounters an obstacle, it <strong class="text-zinc-400">escalates</strong> back to the orchestrator</li>
        <li>Once all steps are complete, the orchestrator synthesizes the final result</li>
      </ol>
    </div>

    <!-- Add Sub-Agent Dialog -->
    <Teleport to="body">
      <div
        v-if="showAddDialog"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
        @click.self="showAddDialog = false"
      >
        <div class="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-md shadow-2xl">
          <h2 class="text-lg font-semibold text-zinc-100 mb-4">
            Add Sub-Agent
          </h2>
          <div class="space-y-4">
            <div>
              <label class="block text-sm text-zinc-400 mb-1.5">Agent</label>
              <select
                v-model="addAgentId"
                class="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option
                  value=""
                  disabled
                >
                  Select an agent
                </option>
                <option
                  v-for="a in availableAgents"
                  :key="a.id"
                  :value="a.id"
                >
                  {{ a.name }}
                </option>
              </select>
            </div>
            <div>
              <label class="block text-sm text-zinc-400 mb-1.5">Codename</label>
              <p class="text-xs text-zinc-600 mb-2">
                A short identifier the orchestrator uses to invoke this agent.
              </p>
              <input
                v-model="addCodename"
                type="text"
                placeholder="e.g. web-researcher"
                class="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
            </div>
            <div>
              <label class="block text-sm text-zinc-400 mb-1.5">Role Description</label>
              <p class="text-xs text-zinc-600 mb-2">
                What this agent specializes in. Helps the orchestrator choose the right agent for each task.
              </p>
              <textarea
                v-model="addRole"
                placeholder="e.g. Searches the web and summarizes findings"
                class="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none h-20"
              />
            </div>
          </div>
          <div class="flex justify-end gap-2 mt-6">
            <button
              class="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
              @click="showAddDialog = false"
            >
              Cancel
            </button>
            <button
              :disabled="!addAgentId || !addCodename.trim()"
              class="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-lg text-sm font-medium transition-colors"
              @click="addSubAgent"
            >
              Add
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
