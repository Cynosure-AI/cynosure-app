<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAgentHealthStore } from '../../stores/agent-health.store'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import type { AgentDefinition, SubAgentAssignment } from '../../api/types'
import { Icon } from '@iconify/vue'
import BaseCard from '../shared/BaseCard.vue'

const props = defineProps<{ agent: AgentDefinition }>()
const emit = defineEmits<{ update: [field: string, value: unknown] }>()

const router = useRouter()
const agentDefs = useAgentDefinitionsStore()
const agentHealth = useAgentHealthStore()

const searchText = ref('')

const assignments = computed<SubAgentAssignment[]>(() => props.agent.subAgents || [])
const assignedIds = computed(() => new Set(assignments.value.map(sa => sa.agentId)))

const assignedAgents = computed(() =>
  assignments.value
    .map(sa => agentDefs.get(sa.agentId))
    .filter((agent): agent is AgentDefinition => !!agent)
)

/** The server drops a second sub-agent with an internal name already in use, so block it here. */
const assignedInternalNames = computed(() => new Set(assignedAgents.value.map(agent => agent.internalName)))

const missingSubAgents = computed(() => {
  const missingIds = new Set(agentHealth.validate(props.agent).subAgents)
  return assignments.value.filter(sa => missingIds.has(sa.agentId))
})

interface Candidate {
  agent: AgentDefinition
  blockedReason: string
}

/** Every other agent that is not yet assigned, favorites first. */
const candidates = computed<Candidate[]>(() =>
  agentDefs.agents
    .filter(agent => agent.id !== props.agent.id && !assignedIds.value.has(agent.id))
    .map(agent => ({
      agent,
      blockedReason: assignedInternalNames.value.has(agent.internalName)
        ? `Another sub-agent already uses the internal name "${agent.internalName}".`
        : '',
    }))
    .sort((a, b) => Number(b.agent.favorite) - Number(a.agent.favorite) || a.agent.name.localeCompare(b.agent.name))
)

const filteredCandidates = computed(() => {
  const query = searchText.value.trim().toLowerCase()
  if (!query) return candidates.value
  return candidates.value.filter(({ agent }) =>
    agent.name.toLowerCase().includes(query) ||
    agent.internalName.toLowerCase().includes(query) ||
    agent.description.toLowerCase().includes(query)
  )
})

function addSubAgent(agentId: string) {
  if (assignedIds.value.has(agentId)) return
  emit('update', 'subAgents', [...assignments.value, { agentId }])
}

function removeSubAgent(agentId: string) {
  emit('update', 'subAgents', assignments.value.filter(sa => sa.agentId !== agentId))
}

function removeAll() {
  emit('update', 'subAgents', [])
}

function removeMissing() {
  const missingIds = new Set(missingSubAgents.value.map(sa => sa.agentId))
  emit('update', 'subAgents', assignments.value.filter(sa => !missingIds.has(sa.agentId)))
}

function openAgent(agentId: string) {
  void router.push(`/agents/${agentId}`)
}

function goToAgents() {
  void router.push('/agents')
}
</script>

<template>
  <div class="space-y-4">
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
              class="inline-flex max-w-full items-center gap-1 break-all px-2 py-0.5 rounded bg-amber-500/10 text-[10px] font-mono text-amber-300/80"
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

    <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <!-- Assigned team -->
      <BaseCard
        class="flex min-w-0 flex-col p-5"
        data-test="assigned-sub-agents"
      >
        <div class="mb-1 flex items-center justify-between gap-3">
          <div class="flex items-center gap-2">
            <Icon
              icon="lucide:users"
              class="h-4 w-4 text-accent-fg"
            />
            <h3 class="text-sm font-medium text-theme-200">
              Assigned sub-agents
            </h3>
            <span class="rounded bg-theme-800 px-1.5 py-0.5 text-[10px] text-ink-secondary">
              {{ assignedAgents.length }}
            </span>
          </div>
          <button
            v-if="assignedAgents.length > 1"
            class="text-[11px] text-ink-secondary transition-colors hover:text-status-danger"
            @click="removeAll"
          >
            Remove all
          </button>
        </div>
        <p class="mb-3 text-xs text-ink-muted">
          <template v-if="assignedAgents.length">
            This agent acts as orchestrator and delegates to these agents by internal name.
          </template>
          <template v-else>
            Add agents from the library to let this agent plan tasks and delegate them.
          </template>
        </p>

        <div
          v-if="!assignedAgents.length"
          class="flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-theme-700 px-4 py-8 text-center"
        >
          <Icon
            icon="lucide:git-fork"
            class="mb-2 h-6 w-6 text-ink-faint"
          />
          <p class="text-xs text-ink-secondary">
            No sub-agents assigned
          </p>
          <p class="mt-1 text-[11px] text-ink-faint">
            This agent handles every task itself.
          </p>
        </div>

        <ul
          v-else
          class="space-y-2"
        >
          <li
            v-for="sub in assignedAgents"
            :key="sub.id"
            class="group rounded-lg border border-theme-700/70 bg-theme-800/50 p-3"
            :data-test="`assigned-${sub.id}`"
          >
            <div class="flex items-start gap-3">
              <div class="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-linear-to-br from-accent-500/20 to-purple-500/20">
                <img
                  v-if="sub.iconUrl"
                  :src="sub.iconUrl"
                  alt=""
                  class="h-full w-full object-cover"
                >
                <Icon
                  v-else
                  icon="lucide:bot"
                  class="h-4 w-4 text-accent-fg"
                />
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span class="truncate text-sm font-medium text-theme-200">{{ sub.name }}</span>
                  <code class="rounded bg-theme-900 px-1.5 py-0.5 font-mono text-[10px] text-ink-secondary">{{ sub.internalName }}</code>
                </div>
                <p
                  v-if="sub.description"
                  class="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-muted"
                >
                  {{ sub.description }}
                </p>
                <p
                  v-else
                  class="mt-1 flex items-center gap-1 text-[11px] text-status-warning"
                >
                  <Icon
                    icon="lucide:alert-triangle"
                    class="h-3 w-3 shrink-0"
                  />
                  No description — the orchestrator uses it to decide when to delegate.
                </p>
                <div class="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-ink-faint">
                  <span
                    v-if="sub.model"
                    class="inline-flex items-center gap-1 rounded bg-theme-900 px-1.5 py-0.5"
                  >
                    <Icon
                      icon="lucide:cpu"
                      class="h-3 w-3"
                    />
                    {{ sub.model }}
                  </span>
                  <span class="inline-flex items-center gap-1 rounded bg-theme-900 px-1.5 py-0.5">
                    <Icon
                      icon="lucide:wrench"
                      class="h-3 w-3"
                    />
                    {{ sub.autoToolRouting ? 'auto tools' : `${sub.tools.length} tool${sub.tools.length === 1 ? '' : 's'}` }}
                  </span>
                  <span
                    v-if="sub.subAgents?.length"
                    class="inline-flex items-center gap-1 rounded bg-theme-900 px-1.5 py-0.5"
                    title="Sub-agents of a delegated agent are not used when it runs as a sub-agent."
                  >
                    <Icon
                      icon="lucide:info"
                      class="h-3 w-3"
                    />
                    own sub-agents inactive
                  </span>
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-0.5">
                <button
                  class="rounded-md p-1.5 text-ink-muted transition-colors hover:bg-theme-700 hover:text-theme-200"
                  :aria-label="`Open ${sub.name}`"
                  title="Open agent"
                  @click="openAgent(sub.id)"
                >
                  <Icon
                    icon="lucide:external-link"
                    class="h-3.5 w-3.5"
                  />
                </button>
                <button
                  class="rounded-md p-1.5 text-ink-muted transition-colors hover:bg-theme-700 hover:text-status-danger"
                  :aria-label="`Remove ${sub.name}`"
                  title="Remove sub-agent"
                  @click="removeSubAgent(sub.id)"
                >
                  <Icon
                    icon="lucide:x"
                    class="h-4 w-4"
                  />
                </button>
              </div>
            </div>
          </li>
        </ul>
      </BaseCard>

      <!-- Agent library -->
      <BaseCard
        class="flex min-w-0 flex-col p-5"
        data-test="sub-agent-library"
      >
        <div class="mb-1 flex items-center justify-between gap-3">
          <div class="flex items-center gap-2">
            <Icon
              icon="lucide:library"
              class="h-4 w-4 text-accent-fg"
            />
            <h3 class="text-sm font-medium text-theme-200">
              Available agents
            </h3>
            <span class="rounded bg-theme-800 px-1.5 py-0.5 text-[10px] text-ink-secondary">
              {{ candidates.length }}
            </span>
          </div>
          <button
            class="flex items-center gap-1 px-2 py-1 text-xs text-ink-secondary transition-colors hover:text-theme-200"
            @click="goToAgents"
          >
            <Icon
              icon="lucide:external-link"
              class="h-3 w-3"
            />
            Manage
          </button>
        </div>
        <p class="mb-3 text-xs text-ink-muted">
          Click an agent to add it as a sub-agent.
        </p>

        <div
          v-if="candidates.length"
          class="relative mb-2"
        >
          <Icon
            icon="lucide:search"
            class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted"
          />
          <input
            v-model="searchText"
            type="text"
            placeholder="Search by name, internal name, or description..."
            aria-label="Search agents"
            class="w-full rounded-lg border border-theme-700 bg-theme-800 py-1.5 pl-8 pr-3 text-xs text-theme-200 placeholder:text-ink-muted focus:outline-none focus:ring-1 focus:ring-accent-500"
          >
        </div>

        <ul
          v-if="filteredCandidates.length"
          class="-mx-1 max-h-[28rem] space-y-0.5 overflow-y-auto px-1"
        >
          <li
            v-for="{ agent: candidate, blockedReason } in filteredCandidates"
            :key="candidate.id"
          >
            <button
              type="button"
              class="flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors"
              :class="blockedReason ? 'cursor-not-allowed opacity-55' : 'hover:bg-theme-800/70'"
              :disabled="!!blockedReason"
              :title="blockedReason || `Add ${candidate.name}`"
              :data-test="`candidate-${candidate.id}`"
              @click="addSubAgent(candidate.id)"
            >
              <div class="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-linear-to-br from-accent-500/20 to-purple-500/20">
                <img
                  v-if="candidate.iconUrl"
                  :src="candidate.iconUrl"
                  alt=""
                  class="h-full w-full object-cover"
                >
                <Icon
                  v-else
                  icon="lucide:bot"
                  class="h-3.5 w-3.5 text-accent-fg"
                />
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <Icon
                    v-if="candidate.favorite"
                    icon="lucide:star"
                    class="h-3 w-3 shrink-0 text-amber-300"
                  />
                  <span class="truncate text-xs font-medium text-theme-200">{{ candidate.name }}</span>
                  <code class="font-mono text-[10px] text-ink-faint">{{ candidate.internalName }}</code>
                </div>
                <p
                  class="mt-0.5 line-clamp-1 text-[11px]"
                  :class="blockedReason ? 'text-status-warning' : 'text-ink-muted'"
                >
                  {{ blockedReason || candidate.description || 'No description' }}
                </p>
              </div>
              <Icon
                v-if="!blockedReason"
                icon="lucide:plus"
                class="mt-1 h-4 w-4 shrink-0 text-accent-fg"
              />
            </button>
          </li>
        </ul>

        <div
          v-else
          class="flex flex-1 flex-col items-center justify-center px-4 py-8 text-center"
        >
          <template v-if="searchText && candidates.length">
            <p class="text-xs text-ink-muted">
              No agents match "{{ searchText }}"
            </p>
          </template>
          <template v-else-if="assignedAgents.length">
            <Icon
              icon="lucide:check-check"
              class="mb-2 h-6 w-6 text-ink-faint"
            />
            <p class="text-xs text-ink-muted">
              Every agent is already assigned.
            </p>
          </template>
          <template v-else>
            <p class="text-xs text-ink-muted">
              No other agents yet.
            </p>
            <button
              class="mt-2 text-xs font-medium text-accent-fg transition-colors hover:text-accent-fg/80"
              @click="goToAgents"
            >
              Create an agent
            </button>
          </template>
        </div>
      </BaseCard>
    </div>

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
        <li>For each step, it creates <strong class="text-ink-secondary">instructions</strong> and invokes the sub-agent whose description fits best</li>
        <li>Sub-agents execute their specialized tasks with their own model and tools, and report results</li>
        <li>If a sub-agent encounters an obstacle, it <strong class="text-ink-secondary">escalates</strong> back to the orchestrator</li>
        <li>Once all steps are complete, the orchestrator synthesizes the final result</li>
      </ol>
    </BaseCard>
  </div>
</template>
