<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import type { AgentDefinition, SubAgentAssignment } from '../../api/types'
import { Icon } from '@iconify/vue'
import AgentSelect from '../shared/AgentSelect.vue'
import BaseCard from '../shared/BaseCard.vue'
import DataTable from '../shared/DataTable.vue'
import type { Column } from '../shared/DataTable.vue'

const props = defineProps<{ agent: AgentDefinition }>()
const emit = defineEmits<{ update: [field: string, value: unknown] }>()

const agentDefs = useAgentDefinitionsStore()

const showAddDialog = ref(false)
const addAgentId = ref('')

const availableAgents = computed(() => {
  const assignedIds = new Set((props.agent.subAgents || []).map(sa => sa.agentId))
  assignedIds.add(props.agent.id) // exclude self
  return agentDefs.agents.filter(a => !assignedIds.has(a.id))
})

const missingSubAgents = computed(() =>
  (props.agent.subAgents || []).filter(sa => !agentDefs.get(sa.agentId))
)


function removeMissing() {
  const missingIds = new Set(missingSubAgents.value.map(sa => sa.agentId))
  emit('update', 'subAgents', (props.agent.subAgents || []).filter(sa => !missingIds.has(sa.agentId)))
}


function addSubAgent() {
  if (!addAgentId.value) return
  const newAssignment: SubAgentAssignment = {
    agentId: addAgentId.value,
  }
  emit('update', 'subAgents', [...(props.agent.subAgents || []), newAssignment])
  showAddDialog.value = false
  addAgentId.value = ''
}

function removeSubAgent(agentId: string) {
  emit('update', 'subAgents', (props.agent.subAgents || []).filter(sa => sa.agentId !== agentId))
}

function getAgentName(id: string): string {
  return agentDefs.get(id)?.name || 'Unknown Agent'
}

function getAgentInternalName(id: string): string {
  return agentDefs.get(id)?.internalName || ''
}

function getAgentDescription(id: string): string {
  return agentDefs.get(id)?.description || ''
}

function getAgentIcon(id: string): string | null {
  return agentDefs.get(id)?.iconUrl || null
}

type SubAgentItem = SubAgentAssignment & { id: string }

const subAgentItems = computed<SubAgentItem[]>(() =>
  (props.agent.subAgents || []).map(sa => ({ ...sa, id: sa.agentId }))
)

const subAgentColumns: Column<SubAgentItem>[] = [
  { key: 'agent', label: 'Agent', width: 'minmax(0, 2fr)' },
  { key: 'internalName', label: 'Internal Name', width: 'minmax(0, 1.5fr)' },
  { key: 'description', label: 'Description', width: 'minmax(0, 2fr)' },
  { key: 'actions', label: '', width: '48px' },
]
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between mb-2">
      <div>
        <p class="text-sm text-ink-secondary">
          Assign sub-agents for multi-agent orchestration.
        </p>
        <p class="text-xs text-ink-faint mt-1">
          When sub-agents are assigned, the agent acts as orchestrator — planning tasks and delegating to sub-agents by internal name.
        </p>
      </div>
      <button
        class="flex items-center gap-2 px-3 py-1.5 accent-action bg-accent-600 hover:bg-accent-500 text-accent-on rounded-lg text-xs font-medium transition-colors"
        @click="showAddDialog = true"
      >
        <Icon
          icon="lucide:plus"
          class="w-3.5 h-3.5"
        />
        Add Sub-Agent
      </button>
    </div>

    <!-- Missing sub-agents warning -->
    <div
      v-if="missingSubAgents.length"
      class="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3"
    >
      <div class="flex items-start gap-2">
        <Icon
          icon="lucide:alert-triangle"
          class="w-4 h-4 text-status-warning shrink-0 mt-0.5"
        />
        <div class="flex-1 min-w-0">
          <p class="text-xs font-medium text-amber-300">
            {{ missingSubAgents.length }} assigned sub-agent{{ missingSubAgents.length > 1 ? 's' : '' }} unavailable
          </p>
          <p class="text-[11px] text-status-warning/60 mt-0.5">
            These sub-agents are assigned but no longer found in your agent library.
          </p>
          <div class="mt-2 flex flex-wrap gap-1.5">
            <span
              v-for="sa in missingSubAgents"
              :key="sa.agentId"
              class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/10 text-[10px] font-mono text-amber-300/80"
            >
              <Icon
                icon="lucide:unplug"
                class="w-3 h-3"
              />
              {{ sa.agentId }}
            </span>
          </div>
          <button
            class="mt-2.5 text-[11px] font-medium text-status-warning hover:text-amber-300 transition-colors flex items-center gap-1"
            @click="removeMissing"
          >
            <Icon
              icon="lucide:trash-2"
              class="w-3 h-3"
            />
            Remove unavailable sub-agents
          </button>
        </div>
      </div>
    </div>

    <!-- Sub-agents table -->
    <DataTable
      :items="subAgentItems"
      :columns="subAgentColumns"
      empty-message="No sub-agents assigned yet. Use 'Add Sub-Agent' to get started."
    >
      <template #col-agent="{ item }">
        <div class="flex items-center gap-2.5">
          <div class="w-7 h-7 rounded-lg bg-linear-to-br from-accent-500/20 to-purple-500/20 flex items-center justify-center overflow-hidden shrink-0">
            <img
              v-if="getAgentIcon(item.agentId)"
              :src="getAgentIcon(item.agentId)!"
              alt=""
              class="w-full h-full object-cover"
            >
            <Icon
              v-else
              icon="lucide:bot"
              class="w-3.5 h-3.5 text-accent-fg"
            />
          </div>
          <div class="min-w-0 flex items-center gap-1.5">
            <span class="text-sm font-medium text-theme-200 truncate">{{ getAgentName(item.agentId) }}</span>
            <Icon
              v-if="!agentDefs.get(item.agentId)"
              icon="lucide:alert-triangle"
              class="w-3.5 h-3.5 text-status-warning shrink-0"
            />
          </div>
        </div>
      </template>

      <template #col-internalName="{ item }">
        <span class="text-xs text-theme-200 font-mono">{{ getAgentInternalName(item.agentId) }}</span>
      </template>

      <template #col-description="{ item }">
        <p class="text-xs leading-relaxed text-theme-200">
          {{ getAgentDescription(item.agentId) || '—' }}
        </p>
      </template>

      <template #col-actions="{ item }">
        <button
          class="p-1.5 text-ink-muted hover:text-status-danger rounded-md transition-all"
          @click.stop="removeSubAgent(item.agentId)"
        >
          <Icon
            icon="lucide:trash-2"
            class="w-4 h-4"
          />
        </button>
      </template>
    </DataTable>

    <!-- How it works -->
    <BaseCard class="p-5">
      <h3 class="text-sm font-medium text-theme-300 mb-2 flex items-center gap-2">
        <Icon
          icon="lucide:info"
          class="w-4 h-4 text-accent-fg"
        />
        How Sub-Agent Orchestration Works
      </h3>
      <ol class="text-xs text-ink-muted space-y-1.5 ml-6 list-decimal">
        <li>When you chat with this agent, it receives the task and creates a <strong class="text-ink-secondary">plan</strong></li>
        <li>For each step, it creates <strong class="text-ink-secondary">instructions</strong> and invokes the assigned sub-agent</li>
        <li>Sub-agents execute their specialized tasks and report results</li>
        <li>If a sub-agent encounters an obstacle, it <strong class="text-ink-secondary">escalates</strong> back to the orchestrator</li>
        <li>Once all steps are complete, the orchestrator synthesizes the final result</li>
      </ol>
    </BaseCard>

    <!-- Add Sub-Agent Dialog -->
    <Teleport to="body">
      <div
        v-if="showAddDialog"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
        @click.self="showAddDialog = false"
      >
        <div class="bg-theme-900 border border-theme-700 rounded-xl p-6 w-full max-w-md shadow-xl">
          <h2 class="text-lg font-semibold text-theme-100 mb-4">
            Add Sub-Agent
          </h2>
          <div class="space-y-4">
            <div>
              <label class="block text-sm text-ink-secondary mb-1.5">Agent</label>
              <AgentSelect
                :model-value="addAgentId"
                :agents="availableAgents"
                placeholder="Select an agent"
                max-height="max-h-56"
                @change="addAgentId = $event"
              />
            </div>
            <div
              v-if="addAgentId"
              class="rounded-lg bg-theme-800 border border-theme-700 p-3 space-y-1.5"
            >
              <div class="flex items-center gap-2">
                <span class="text-xs text-ink-muted">Internal Name:</span>
                <span class="text-xs text-theme-200 font-mono">{{ getAgentInternalName(addAgentId) || '—' }}</span>
              </div>
              <div class="flex items-center gap-2">
                <span class="text-xs text-ink-muted">Description:</span>
                <span class="text-xs text-theme-200">{{ getAgentDescription(addAgentId) || '—' }}</span>
              </div>
            </div>
          </div>
          <div class="flex justify-end gap-2 mt-6">
            <button
              class="px-4 py-2 text-sm text-ink-secondary hover:text-theme-200 transition-colors"
              @click="showAddDialog = false"
            >
              Cancel
            </button>
            <button
              :disabled="!addAgentId"
              class="px-4 py-2 accent-action bg-accent-600 hover:bg-accent-500 disabled:bg-theme-700 disabled:text-ink-muted text-accent-on rounded-lg text-sm font-medium transition-colors"
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
