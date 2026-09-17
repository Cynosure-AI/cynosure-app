<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { useAgentStore } from '../stores/agent-runtime.store'
import { useProviderStore } from '../stores/provider.store'
import { useProviderLogos } from '../composables/useProviderLogos'
import DataTable from '../components/shared/DataTable.vue'
import HoverTooltip from '../components/shared/HoverTooltip.vue'
import ModalDialog from '../components/shared/ModalDialog.vue'
import ProviderModelSelect from '../components/shared/ProviderModelSelect.vue'
import type { Column } from '../components/shared/DataTable.vue'
import type { AgentDefinition } from '../api/types'

const agentDefs = useAgentDefinitionsStore()
const agentStore = useAgentStore()
const providerStore = useProviderStore()
const router = useRouter()
const { logoUrl } = useProviderLogos()
const TOOLTIP_MAX_TOOLS = 20

const showCreateDialog = ref(false)
const newName = ref('')
const newDescription = ref('')
const showDeleteConfirm = ref(false)
const pendingDeleteId = ref<string | null>(null)
const pendingDeleteName = ref('')
const searchQuery = ref('')
const page = ref(0)
const selectedAgentIds = ref<string[]>([])
const activeSortKey = ref<string | null>(null)
const editProviderId = ref('')
const editModel = ref('')
const editSaving = ref(false)
const dragReorderId = ref<string | null>(null)
const dropTargetId = ref<string | null>(null)

onMounted(() => agentDefs.load())

function getProviderName(agent: AgentDefinition): string {
  return providerStore.providers.find(provider => provider.id === agent.providerId)?.name || 'Unknown'
}
function getModelDisplayName(agent: AgentDefinition): string {
  if (!agent.model) return 'No model selected'
  return agent.model.split('/').filter(Boolean).at(-1) || agent.model
}
function getProviderLogoUrl(agent: AgentDefinition): string | null {
  const provider = providerStore.providers.find(item => item.id === agent.providerId)
  return provider ? logoUrl(provider.type) : null
}
function matchesSearch(agent: AgentDefinition, query: string): boolean {
  return [agent.name, agent.description || '', agent.model || '', getProviderName(agent)]
    .some(value => value.toLocaleLowerCase().includes(query))
}
function defaultAgentSort(a: AgentDefinition, b: AgentDefinition): number {
  if (a.favorite !== b.favorite) return a.favorite ? -1 : 1
  return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name)
}

const tableAgents = computed(() => [...agentDefs.agents].sort(defaultAgentSort))
const hasAnyAgents = computed(() => agentDefs.agents.length > 0)
const hasFilters = computed(() => Boolean(searchQuery.value.trim()))
const agentColumns: Column<AgentDefinition>[] = [
  { key: 'favorite', label: '', width: '36px', sortable: true, sortValue: agent => agent.favorite },
  { key: 'name', label: 'Name', width: 'minmax(240px, 1.45fr)', sortable: true, sortValue: agent => agent.name },
  { key: 'model', label: 'Model / Provider', width: 'minmax(200px, 0.85fr)', sortable: true, editable: true, sortValue: agent => `${getModelDisplayName(agent)}\u0000${getProviderName(agent)}` },
  { key: 'info', label: 'Info', width: '130px' },
  { key: 'date', label: 'Date', width: '140px', sortable: true, sortValue: agent => agent.createdAt },
  { key: 'actions', label: 'Actions', width: '84px', class: 'text-right' },
]
const agentsWithIssues = computed(() => {
  const availableKeys = new Set(agentStore.availableTools.map(tool => tool.key))
  const allAgentIds = new Set(agentDefs.agents.map(agent => agent.id))
  return new Set(agentDefs.agents.filter(agent =>
    agent.tools.some(tool => !availableKeys.has(tool))
    || (agent.subAgents || []).some(subAgent => !allAgentIds.has(subAgent.agentId)),
  ).map(agent => agent.id))
})

watch(searchQuery, () => { page.value = 0 })

function clearFilters(): void {
  searchQuery.value = ''
}

function startInlineEdit(item: AgentDefinition, column: Column<AgentDefinition>): void {
  editSaving.value = false
  if (column.key === 'model') {
    editProviderId.value = item.providerId
    editModel.value = item.model
  }
}

function toolNamespaces(agent: AgentDefinition): { mcps: string[]; categories: string[] } {
  const namespaces = new Map<string, { id: string; label: string }>()
  for (const key of agent.tools) {
    const namespace = agentStore.availableTools.find(tool => tool.key === key)?.namespace
    if (namespace) namespaces.set(namespace.id, namespace)
  }
  const values = [...namespaces.values()]
  return {
    mcps: values.filter(namespace => namespace.id.startsWith('mcp:')).map(namespace => namespace.label),
    categories: values
      .filter(namespace => !namespace.id.startsWith('mcp:'))
      .map(namespace => namespace.label.replace(/^Built-In:\s*/i, '')),
  }
}
async function saveInlineModel(items: AgentDefinition[], finish: () => void): Promise<void> {
  if (!editProviderId.value || editSaving.value) return
  editSaving.value = true
  try {
    await Promise.all(items.map(agent => agentDefs.update(agent.id, { providerId: editProviderId.value, model: editModel.value })))
    finish()
  } finally { editSaving.value = false }
}
async function createAgent(): Promise<void> {
  if (!newName.value.trim()) return
  const agent = await agentDefs.create({
    name: newName.value.trim(), internalName: '', description: newDescription.value.trim(), category: '',
    favorite: false, iconUrl: null, providerId: providerStore.lastUsedProviderId || '',
    model: providerStore.lastUsedProvider?.defaultModel || '', systemPrompt: '', cronPrompt: '', tools: [],
    autoApproveTools: false, autoToolRouting: false, autoMemory: true, dreamingEnabled: true, generateTitle: true,
  })
  showCreateDialog.value = false
  newName.value = ''
  newDescription.value = ''
  router.push(`/agents/${agent.id}`)
}
async function deleteAgent(id: string): Promise<void> {
  await agentDefs.remove(id)
  selectedAgentIds.value = selectedAgentIds.value.filter(item => item !== id)
  showDeleteConfirm.value = false
  pendingDeleteId.value = null
}
function confirmDelete(agent: AgentDefinition): void {
  pendingDeleteId.value = agent.id
  pendingDeleteName.value = agent.name
  showDeleteConfirm.value = true
}
async function duplicateAgent(id: string): Promise<void> { await agentDefs.duplicate(id) }
async function toggleFavorite(agent: AgentDefinition): Promise<void> { await agentDefs.update(agent.id, { favorite: !agent.favorite }) }

function onReorderDragStart(event: DragEvent, agentId: string): void {
  if (activeSortKey.value) return
  dragReorderId.value = agentId
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', agentId)
  }
}
function onReorderDragOver(event: DragEvent, targetId: string): void {
  if (activeSortKey.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  if (!dragReorderId.value || dragReorderId.value === targetId) {
    dropTargetId.value = null
    return
  }
  dropTargetId.value = targetId
}
function onReorderDragLeave(event: DragEvent, targetId: string): void {
  const related = event.relatedTarget as HTMLElement | null
  const current = event.currentTarget as HTMLElement
  if ((!related || !current.contains(related)) && dropTargetId.value === targetId) dropTargetId.value = null
}
async function onReorderDrop(event: DragEvent, targetId: string): Promise<void> {
  event.preventDefault()
  const draggedId = dragReorderId.value
  dragReorderId.value = null
  dropTargetId.value = null
  if (!draggedId || draggedId === targetId) return
  const list = [...tableAgents.value]
  const fromIndex = list.findIndex(agent => agent.id === draggedId)
  const targetIndex = list.findIndex(agent => agent.id === targetId)
  if (fromIndex < 0 || targetIndex < 0) return
  const [moved] = list.splice(fromIndex, 1)
  // Keep the target's original numeric position. This makes dropping onto an
  // adjacent row exchange their positions in either direction.
  list.splice(targetIndex, 0, moved)
  await Promise.all(list.map((agent, index) => agent.sortOrder === index ? Promise.resolve() : agentDefs.update(agent.id, { sortOrder: index })))
}
function onReorderDragEnd(): void {
  dragReorderId.value = null
  dropTargetId.value = null
}
function agentRowClass(agent: AgentDefinition): string | undefined {
  if (dragReorderId.value === agent.id) return 'opacity-60'
  if (dropTargetId.value === agent.id) return 'ring-1 ring-inset ring-accent-500/70'
  return undefined
}
function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="mx-auto max-w-[1600px] px-4 py-8 sm:px-6">
      <div class="mb-6 flex items-start justify-between gap-4">
        <div class="min-w-0">
          <h1 class="text-2xl font-bold text-theme-100">
            Agents
          </h1>
          <p class="mt-1 text-sm text-theme-500">
            Create and manage AI agents with custom configurations and favorites.
          </p>
        </div>
        <button
          class="flex shrink-0 items-center gap-2 rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white hover:bg-accent-500"
          @click="showCreateDialog = true"
        >
          <Icon
            icon="lucide:plus"
            class="h-4 w-4"
          /> New Agent
        </button>
      </div>

      <div
        v-if="hasAnyAgents"
        class="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center"
      >
        <div class="relative min-w-0 flex-1">
          <Icon
            icon="lucide:search"
            class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-500"
          />
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Search agents, providers, or models..."
            class="w-full rounded-lg border border-theme-700/60 bg-theme-800/60 py-2 pl-10 pr-9 text-sm text-theme-200 placeholder:text-theme-600 focus:outline-none focus:ring-1 focus:ring-accent-500/60"
          >
          <button
            v-if="searchQuery"
            class="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-theme-500 hover:text-theme-300"
            aria-label="Clear search"
            @click="searchQuery = ''"
          >
            <Icon
              icon="lucide:x"
              class="h-4 w-4"
            />
          </button>
        </div>
      </div>

      <div
        v-if="selectedAgentIds.length"
        class="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-accent-500/25 bg-accent-500/8 px-3 py-2"
      >
        <p class="text-xs text-theme-400">
          <span class="font-medium text-theme-200">{{ selectedAgentIds.length }} selected.</span> Double-click the Model cell to edit all selected agents.
        </p>
        <button
          class="text-xs text-theme-500 hover:text-theme-200"
          @click="selectedAgentIds = []"
        >
          Clear selection
        </button>
      </div>

      <DataTable
        v-if="hasAnyAgents"
        v-model:selected-ids="selectedAgentIds"
        v-model:page="page"
        :items="tableAgents"
        :columns="agentColumns"
        :filter-text="searchQuery"
        :filter-predicate="matchesSearch"
        selectable
        pagination
        :page-size="20"
        pagination-position="both"
        row-clickable
        :row-draggable="() => !activeSortKey"
        :row-class="agentRowClass"
        :empty-message="hasFilters ? 'No agents match the current filters.' : 'No agents found.'"
        @row-click="router.push(`/agents/${$event.id}`)"
        @sort-change="activeSortKey = $event; onReorderDragEnd()"
        @cell-edit-start="startInlineEdit"
        @row-dragstart="(item, event) => onReorderDragStart(event, item.id)"
        @row-dragover="(item, event) => onReorderDragOver(event, item.id)"
        @row-dragleave="(item, event) => onReorderDragLeave(event, item.id)"
        @row-drop="(item, event) => onReorderDrop(event, item.id)"
        @row-dragend="onReorderDragEnd"
      >
        <template #col-favorite="{ item }">
          <button
            class="rounded-md p-1"
            :class="item.favorite ? 'text-amber-400 [&>svg]:fill-current' : 'text-theme-600 hover:text-amber-400'"
            :title="item.favorite ? 'Remove from favorites' : 'Add to favorites'"
            @click.stop="toggleFavorite(item)"
          >
            <Icon
              icon="lucide:star"
              class="h-4 w-4"
            />
          </button>
        </template>
        <template #col-name="{ item }">
          <div
            class="flex min-w-0 items-start gap-3"
            :class="activeSortKey ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'"
          >
            <div class="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-linear-to-br from-accent-500/20 to-purple-500/20">
              <img
                v-if="item.iconUrl"
                :src="item.iconUrl"
                alt=""
                class="h-full w-full object-cover"
              >
              <Icon
                v-else
                icon="lucide:bot"
                class="h-4 w-4 text-accent-400"
              />
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1 text-sm font-medium text-theme-100">
                <span class="truncate">{{ item.name }}</span><Icon
                  v-if="agentsWithIssues.has(item.id)"
                  icon="lucide:alert-triangle"
                  class="h-3.5 w-3.5 shrink-0 text-amber-400"
                />
              </div>
              <div
                v-if="item.description"
                class="mt-0.5 line-clamp-2 text-xs text-theme-500"
              >
                {{ item.description }}
              </div>
            </div>
          </div>
        </template>
        <template #col-model="{ item }">
          <div class="flex min-w-0 items-center gap-2 pr-4">
            <img
              v-if="getProviderLogoUrl(item)"
              :src="getProviderLogoUrl(item) || ''"
              :alt="getProviderName(item)"
              class="h-5 w-5 shrink-0 rounded object-contain"
            >
            <div class="min-w-0">
              <div class="truncate text-[13px] font-medium text-theme-200">
                {{ getModelDisplayName(item) }}
              </div>
            </div>
          </div>
        </template>
        <template #edit-col-model="{ items, placement, finish, cancel }">
          <ProviderModelSelect
            v-model:provider-id="editProviderId"
            v-model="editModel"
            :providers="providerStore.providers"
            :model-types="['llm', 'image', 'video', 'transcription']"
            :drop-up="placement === 'top'"
            placeholder="Choose the new model"
            size="sm"
            dropdown-width="w-full"
          />
          <div class="mt-3 flex justify-end gap-2">
            <button
              class="rounded-md px-3 py-1.5 text-xs text-theme-400 hover:bg-theme-800"
              @click="cancel"
            >
              Cancel
            </button>
            <button
              class="rounded-md bg-accent-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-500 disabled:opacity-50"
              :disabled="!editProviderId || editSaving"
              @click="saveInlineModel(items, finish)"
            >
              {{ editSaving ? 'Saving…' : `Apply to ${items.length}` }}
            </button>
          </div>
        </template>
        <template #col-info="{ item }">
          <div class="flex items-center gap-2 text-xs text-theme-500">
            <HoverTooltip
              placement="mouse"
              :max-width="220"
            >
              <span
                class="flex items-center gap-1 rounded px-1.5 py-0.5"
                :class="item.autoMemory ? 'bg-emerald-500/15 text-emerald-400' : 'bg-theme-700/50 text-theme-500'"
              ><Icon
                icon="lucide:wrench"
                class="h-3 w-3"
              />{{ item.tools.length }}</span>
              <template #content>
                <div
                  class="mb-2 font-medium"
                  :class="item.autoMemory ? 'text-emerald-400' : 'text-theme-400'"
                >
                  Auto memory is {{ item.autoMemory ? 'enabled' : 'disabled' }}
                </div>
                <div v-if="toolNamespaces(item).mcps.length">
                  <div class="mb-1 font-medium text-theme-400">
                    MCPs
                  </div>
                  <div
                    v-for="name in toolNamespaces(item).mcps"
                    :key="`mcp:${name}`"
                    class="truncate py-0.5 text-[10px] text-theme-300"
                  >
                    {{ name }}
                  </div>
                </div>
                <div
                  v-if="toolNamespaces(item).categories.length"
                  :class="toolNamespaces(item).mcps.length ? 'mt-2' : ''"
                >
                  <div class="mb-1 font-medium text-theme-400">
                    Categories
                  </div>
                  <div
                    v-for="name in toolNamespaces(item).categories"
                    :key="`category:${name}`"
                    class="truncate py-0.5 text-[10px] text-theme-300"
                  >
                    {{ name }}
                  </div>
                </div>
              </template>
            </HoverTooltip>
            <HoverTooltip
              :disabled="!item.subAgents?.length"
              placement="mouse"
              :max-width="220"
            >
              <span class="flex items-center gap-1 rounded bg-theme-700/50 px-1.5 py-0.5"><Icon
                icon="lucide:users"
                class="h-3 w-3"
              />{{ item.subAgents?.length || 0 }}</span>
              <template #content>
                <div class="mb-1.5 font-medium text-theme-300">
                  {{ item.subAgents?.length }} sub-agent{{ item.subAgents?.length === 1 ? '' : 's' }}
                </div><div
                  v-for="subAgent in item.subAgents?.slice(0, TOOLTIP_MAX_TOOLS)"
                  :key="subAgent.agentId"
                  class="truncate py-0.5 text-[10px] text-theme-300"
                >
                  {{ agentDefs.get(subAgent.agentId)?.name ?? subAgent.agentId }}
                </div>
              </template>
            </HoverTooltip>
            <HoverTooltip
              placement="mouse"
              :max-width="220"
            >
              <span
                class="flex items-center rounded px-1.5 py-0.5"
                :class="item.autoToolRouting ? 'bg-emerald-500/15 text-emerald-400' : 'bg-theme-700/50 text-theme-600'"
              ><Icon
                icon="lucide:route"
                class="h-3 w-3"
              /></span>
              <template #content>
                Auto router is {{ item.autoToolRouting ? 'enabled' : 'disabled' }}
              </template>
            </HoverTooltip>
          </div>
        </template>
        <template #col-date="{ item }">
          <div class="flex items-center gap-1 whitespace-nowrap text-xs text-theme-500">
            <Icon
              icon="lucide:calendar"
              class="h-3 w-3"
            />{{ formatDate(item.createdAt) }}
          </div>
        </template>
        <template #col-actions="{ item }">
          <div class="flex items-center justify-end gap-1">
            <button
              class="rounded-md p-1.5 text-theme-500 hover:text-accent-400"
              title="Duplicate agent"
              @click.stop="duplicateAgent(item.id)"
            >
              <Icon
                icon="lucide:copy"
                class="h-4 w-4"
              />
            </button>
            <button
              class="rounded-md p-1.5 text-theme-500 hover:text-red-400"
              title="Delete agent"
              @click.stop="confirmDelete(item)"
            >
              <Icon
                icon="lucide:trash-2"
                class="h-4 w-4"
              />
            </button>
          </div>
        </template>
      </DataTable>

      <section
        v-else
        class="agents-empty-state"
        aria-labelledby="agents-empty-title"
      >
        <div
          class="agents-empty-orbit agents-empty-orbit--top"
          aria-hidden="true"
        />
        <div
          class="agents-empty-orbit agents-empty-orbit--bottom"
          aria-hidden="true"
        />
        <div
          class="agents-empty-dots agents-empty-dots--top"
          aria-hidden="true"
        />
        <div
          class="agents-empty-dots agents-empty-dots--bottom"
          aria-hidden="true"
        />

        <div class="relative z-10 mx-auto flex max-w-6xl flex-col items-center">
          <h2
            id="agents-empty-title"
            class="text-center text-2xl font-semibold tracking-tight text-theme-100 sm:text-3xl"
          >
            No <span class="text-accent-400">Agents</span> Yet
          </h2>
          <p class="mt-2 max-w-2xl text-center text-sm leading-6 text-theme-400 sm:text-base">
            Create your first agent for a smarter, more personal AI experience built around the way you work.
          </p>

          <div class="mt-8 grid w-full gap-3 text-left md:grid-cols-3 md:gap-4">
            <article class="agents-empty-feature">
              <div class="agents-empty-feature-icon">
                <Icon
                  icon="lucide:brain-circuit"
                  class="h-5 w-5"
                />
              </div>
              <div>
                <h3 class="text-sm font-semibold text-theme-100 sm:text-base">
                  Persistent Memory
                </h3>
                <p class="mt-1.5 text-sm leading-5 text-theme-500">
                  Remember context, preferences, and long-term goals so every conversation feels connected.
                </p>
              </div>
            </article>

            <article class="agents-empty-feature">
              <div class="agents-empty-feature-icon">
                <Icon
                  icon="lucide:wrench"
                  class="h-5 w-5"
                />
              </div>
              <div>
                <h3 class="text-sm font-semibold text-theme-100 sm:text-base">
                  Dedicated Tools
                </h3>
                <p class="mt-1.5 text-sm leading-5 text-theme-500">
                  Choose only the tools each agent needs for focused, efficient, and safer work.
                </p>
              </div>
            </article>

            <article class="agents-empty-feature">
              <div class="agents-empty-feature-icon">
                <Icon
                  icon="lucide:user-round"
                  class="h-5 w-5"
                />
              </div>
              <div>
                <h3 class="text-sm font-semibold text-theme-100 sm:text-base">
                  Personalised Behaviour
                </h3>
                <p class="mt-1.5 text-sm leading-5 text-theme-500">
                  Shape the role, tone, model, and capabilities to fit every task and workflow.
                </p>
              </div>
            </article>
          </div>

          <button
            class="agents-empty-cta mt-8 inline-flex items-center gap-2 rounded-xl bg-accent-600 px-5 py-3 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-accent-500 sm:px-6 sm:text-base"
            @click="showCreateDialog = true"
          >
            <Icon
              icon="lucide:plus"
              class="h-5 w-5"
            />
            Create Your First Agent
          </button>
        </div>
      </section>
      <div
        v-if="hasAnyAgents && hasFilters"
        class="mt-4 flex items-center justify-between text-sm text-theme-500"
      >
        <span>Filters active</span><button
          class="text-theme-400 hover:text-theme-200"
          @click="clearFilters"
        >
          Clear filters
        </button>
      </div>

      <ModalDialog
        :show="showCreateDialog"
        title="Create New Agent"
        icon="lucide:bot"
        icon-color="accent"
        @close="showCreateDialog = false"
      >
        <div class="space-y-4">
          <div>
            <label
              for="new-agent-name"
              class="mb-1.5 block text-sm text-theme-400"
            >Name</label><input
              id="new-agent-name"
              v-model="newName"
              type="text"
              autocomplete="off"
              placeholder="My Agent"
              class="w-full rounded-lg border border-theme-700 bg-theme-800 px-3 py-2 text-sm text-theme-200 placeholder:text-theme-600 focus:outline-none focus:ring-1 focus:ring-accent-500"
              @keydown.enter="createAgent"
            >
          </div>
          <div>
            <label
              for="new-agent-description"
              class="mb-1.5 block text-sm text-theme-400"
            >Description <span class="text-theme-600">(optional)</span></label><textarea
              id="new-agent-description"
              v-model="newDescription"
              placeholder="What does this agent do?"
              class="h-20 w-full resize-none rounded-lg border border-theme-700 bg-theme-800 px-3 py-2 text-sm text-theme-200 placeholder:text-theme-600 focus:outline-none focus:ring-1 focus:ring-accent-500"
            />
          </div>
        </div>
        <template #actions>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="px-4 py-2 text-sm text-theme-400 hover:text-theme-200"
              @click="showCreateDialog = false"
            >
              Cancel
            </button><button
              type="button"
              class="rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white hover:bg-accent-500 disabled:opacity-50"
              :disabled="!newName.trim()"
              @click="createAgent"
            >
              Create Agent
            </button>
          </div>
        </template>
      </ModalDialog>
      <ModalDialog
        :show="showDeleteConfirm"
        title="Delete Agent"
        icon="lucide:trash-2"
        icon-color="red"
        @close="showDeleteConfirm = false"
      >
        <p class="leading-relaxed text-theme-400">
          Are you sure you want to delete <strong class="text-theme-200">{{ pendingDeleteName }}</strong>? This action cannot be undone.
        </p>
        <template #actions>
          <button
            class="w-full rounded-xl bg-red-600 px-4 py-3 text-center font-medium text-white hover:bg-red-500"
            @click="deleteAgent(pendingDeleteId!)"
          >
            Delete Agent
          </button><button
            class="w-full rounded-xl bg-theme-800 px-4 py-3 text-center font-medium text-theme-300 hover:bg-theme-700"
            @click="showDeleteConfirm = false"
          >
            Cancel
          </button>
        </template>
      </ModalDialog>
    </div>
  </div>
</template>

<style scoped>
.agents-empty-state {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  min-height: 32rem;
  padding: 2.5rem 2rem;
  border: 1px solid color-mix(in srgb, var(--color-theme-600) 42%, transparent);
  border-radius: 1rem;
  background:
    radial-gradient(circle at 7% 5%, color-mix(in srgb, var(--color-accent-600) 14%, transparent), transparent 18rem),
    radial-gradient(circle at 96% 92%, color-mix(in srgb, var(--color-accent-600) 13%, transparent), transparent 20rem),
    linear-gradient(145deg, color-mix(in srgb, var(--color-theme-800) 78%, transparent), color-mix(in srgb, var(--color-theme-900) 92%, transparent));
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--color-theme-100) 5%, transparent);
}

.agents-empty-state::before {
  position: absolute;
  inset: 0;
  z-index: -1;
  background-image: repeating-linear-gradient(135deg, transparent 0 10px, color-mix(in srgb, var(--color-theme-100) 2%, transparent) 10px 11px);
  mask-image: linear-gradient(to bottom, transparent 35%, #000 100%);
  content: '';
}

.agents-empty-orbit {
  position: absolute;
  width: 20rem;
  height: 20rem;
  border: 1px solid color-mix(in srgb, var(--color-accent-500) 35%, transparent);
  border-radius: 9999px;
  pointer-events: none;
}

.agents-empty-orbit::after {
  position: absolute;
  inset: 4.25rem;
  border: 1px solid color-mix(in srgb, var(--color-theme-300) 12%, transparent);
  border-radius: inherit;
  content: '';
}

.agents-empty-orbit--top {
  top: -12.5rem;
  left: -7rem;
}

.agents-empty-orbit--bottom {
  right: -7.5rem;
  bottom: -13.5rem;
}

.agents-empty-dots {
  position: absolute;
  width: 9rem;
  height: 5rem;
  opacity: .48;
  background-image: radial-gradient(circle, var(--color-accent-400) 1px, transparent 1.5px);
  background-size: 18px 18px;
  pointer-events: none;
}

.agents-empty-dots--top {
  top: 2rem;
  right: 2rem;
  mask-image: linear-gradient(135deg, transparent, #000);
}

.agents-empty-dots--bottom {
  bottom: 2rem;
  left: 2rem;
  mask-image: linear-gradient(315deg, transparent, #000);
}

.agents-empty-icon-wrap {
  position: relative;
  display: grid;
  width: 7.5rem;
  height: 7.5rem;
  place-items: center;
}

.agents-empty-icon-ring {
  position: absolute;
  border: 1px solid color-mix(in srgb, var(--color-accent-500) 33%, transparent);
  border-radius: 9999px;
}

.agents-empty-icon-ring--outer {
  inset: 0;
  box-shadow: inset 0 0 28px color-mix(in srgb, var(--color-accent-500) 5%, transparent);
}

.agents-empty-icon-ring--inner {
  inset: .55rem;
  border-color: color-mix(in srgb, var(--color-accent-400) 24%, transparent);
}

.agents-empty-icon {
  display: grid;
  width: 4.25rem;
  height: 4.25rem;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--color-accent-400) 40%, transparent);
  border-radius: 1.25rem;
  background: radial-gradient(circle at 35% 25%, color-mix(in srgb, var(--color-accent-400) 24%, transparent), color-mix(in srgb, var(--color-theme-900) 93%, transparent));
  color: var(--color-accent-300);
  box-shadow: 0 0 30px color-mix(in srgb, var(--color-accent-500) 20%, transparent), inset 0 1px 0 color-mix(in srgb, var(--color-theme-100) 12%, transparent);
}

.agents-empty-spark {
  position: absolute;
  color: var(--color-accent-400);
  font-size: 1.25rem;
  font-weight: 300;
  line-height: 1;
  text-shadow: 0 0 12px var(--color-accent-500);
}

.agents-empty-spark--left {
  top: 62%;
  left: -.1rem;
}

.agents-empty-spark--right {
  top: 20%;
  right: -.15rem;
}

.agents-empty-feature {
  display: flex;
  min-width: 0;
  gap: 1rem;
  padding: 1.25rem;
  border: 1px solid color-mix(in srgb, var(--color-theme-600) 38%, transparent);
  border-radius: .875rem;
  background: linear-gradient(145deg, color-mix(in srgb, var(--color-theme-800) 58%, transparent), color-mix(in srgb, var(--color-theme-900) 52%, transparent));
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--color-theme-100) 4%, transparent);
  backdrop-filter: blur(8px);
}

.agents-empty-feature-icon {
  display: grid;
  flex: 0 0 auto;
  width: 3rem;
  height: 3rem;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--color-accent-500) 35%, transparent);
  border-radius: 9999px;
  background: color-mix(in srgb, var(--color-accent-500) 12%, transparent);
  color: var(--color-accent-300);
}

.agents-empty-cta {
  color: var(--accent-button-foreground);
  box-shadow: 0 10px 28px color-mix(in srgb, var(--color-accent-600) 28%, transparent), inset 0 1px 0 color-mix(in srgb, #fff 20%, transparent);
}

@media (max-width: 767px) {
  .agents-empty-state {
    min-height: auto;
    padding: 2rem 1rem;
  }

  .agents-empty-feature {
    padding: 1rem;
  }

  .agents-empty-orbit,
  .agents-empty-dots {
    opacity: .45;
  }
}
</style>
