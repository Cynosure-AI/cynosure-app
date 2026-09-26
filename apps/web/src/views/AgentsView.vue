<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import { api } from '../api/client'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { useAgentStore } from '../stores/agent-runtime.store'
import { useProviderStore } from '../stores/provider.store'
import { useProviderLogos } from '../composables/useProviderLogos'
import { useMcpServers } from '../composables/useMcpServers'
import DataTable from '../components/shared/DataTable.vue'
import BaseCard from '../components/shared/BaseCard.vue'
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
const { servers, loadServers } = useMcpServers()
const TOOLTIP_MAX_TOOLS = 20

const showCreateDialog = ref(false)
const newName = ref('')
const newDescription = ref('')
const showDeleteConfirm = ref(false)
const pendingDeleteId = ref<string | null>(null)
const pendingDeleteName = ref('')
const searchQuery = ref('')
const stateFilter = ref<'all' | 'ready' | 'warning'>('all')
const page = ref(0)
const selectedAgentIds = ref<string[]>([])
const activeSortKey = ref<string | null>(null)
const editProviderId = ref('')
const editModel = ref('')
const editSaving = ref(false)
const dragReorderId = ref<string | null>(null)
const dropTargetId = ref<string | null>(null)
const brokenIcons = ref<Set<string>>(new Set())
const availableMemoryFolderIds = ref<Set<string> | null>(null)

onMounted(() => {
  void agentDefs.load()
  void api.memoryFolders.list()
    .then(folders => { availableMemoryFolderIds.value = new Set(folders.map(folder => folder.id)) })
    .catch(() => undefined)
  if (servers.value.length === 0) void loadServers().catch(() => undefined)
})

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
const hasFilters = computed(() => Boolean(searchQuery.value.trim()) || stateFilter.value !== 'all')
const agentColumns: Column<AgentDefinition>[] = [
  { key: 'favorite', label: '', width: '36px', sortable: true, sortValue: agent => agent.favorite },
  { key: 'name', label: 'Name', width: 'minmax(240px, 1.45fr)', sortable: true, sortValue: agent => agent.name },
  { key: 'model', label: 'Model / Provider', width: 'minmax(200px, 0.85fr)', sortable: true, editable: true, sortValue: agent => `${getModelDisplayName(agent)}\u0000${getProviderName(agent)}` },
  { key: 'info', label: 'Info', width: '130px' },
  { key: 'date', label: 'Date', width: '140px', sortable: true, sortValue: agent => agent.createdAt },
  { key: 'actions', label: 'Actions', width: '84px', class: 'text-right' },
]
const agentIssues = computed(() => {
  const availableKeys = new Set(agentStore.availableTools.map(tool => tool.key))
  const allAgentIds = new Set(agentDefs.agents.map(agent => agent.id))
  return new Map(agentDefs.agents.map(agent => [agent.id, [
    ...agent.tools.filter(tool => !availableKeys.has(tool)).map(tool => `Tool: ${tool}`),
    ...(availableMemoryFolderIds.value
      ? (agent.memoryFolders || []).filter(id => !availableMemoryFolderIds.value!.has(id)).map(id => `Memory folder: ${id}`)
      : []),
    ...(agent.subAgents || []).filter(subAgent => !allAgentIds.has(subAgent.agentId))
      .map(subAgent => `Sub-agent: ${subAgent.agentId}`),
  ]] as const))
})
const filteredTableAgents = computed(() => tableAgents.value.filter(agent => {
  if (stateFilter.value === 'all') return true
  const hasIssues = Boolean(agentIssues.value.get(agent.id)?.length)
  return stateFilter.value === 'warning' ? hasIssues : !hasIssues
}))

watch([searchQuery, stateFilter], () => { page.value = 0 })

function clearFilters(): void {
  searchQuery.value = ''
  stateFilter.value = 'all'
}

function startInlineEdit(item: AgentDefinition, column: Column<AgentDefinition>): void {
  editSaving.value = false
  if (column.key === 'model') {
    editProviderId.value = item.providerId
    editModel.value = item.model
  }
}

function toolNamespaces(agent: AgentDefinition): { mcps: { id: string; label: string }[]; categories: string[] } {
  const namespaces = new Map<string, { id: string; label: string }>()
  for (const key of agent.tools) {
    const namespace = agentStore.availableTools.find(tool => tool.key === key)?.namespace
    if (namespace) namespaces.set(namespace.id, namespace)
  }
  const values = [...namespaces.values()]
  return {
    mcps: values.filter(namespace => namespace.id.startsWith('mcp:')),
    categories: values
      .filter(namespace => !namespace.id.startsWith('mcp:'))
      .map(namespace => namespace.label.replace(/^Built-In:\s*/i, '')),
  }
}
function namespaceIcon(namespaceId: string): string | null {
  if (brokenIcons.value.has(namespaceId)) return null
  return servers.value.find(server => server.id === namespaceId.slice(4))?.icon_url ?? null
}
function markIconBroken(namespaceId: string): void {
  brokenIcons.value = new Set([...brokenIcons.value, namespaceId])
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
    <header class="z-10 border-b border-theme-800/60 bg-theme-950/95 py-4 backdrop-blur-sm sm:sticky sm:top-0 sm:py-5">
      <div class="mx-auto flex max-w-7xl flex-col gap-4 px-4 sm:flex-row sm:items-start sm:justify-between sm:px-6 lg:px-8">
        <div class="min-w-0">
          <h1 class="text-2xl font-bold text-theme-100">
            Agents
          </h1>
          <p class="mt-1 text-sm leading-relaxed text-theme-500">
            Create and manage AI agents with custom configurations and favorites.
          </p>
        </div>
        <div class="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
          <label
            v-if="hasAnyAgents"
            class="relative min-w-0 flex-1 basis-full sm:w-80 sm:basis-auto sm:flex-none"
          >
            <span class="sr-only">Search agents</span>
            <Icon
              icon="lucide:search"
              class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-500"
            />
            <input
              v-model="searchQuery"
              type="search"
              placeholder="Search agents, providers, or models..."
              class="h-10 w-full rounded-xl border border-theme-700 bg-theme-950/70 pl-9 pr-9 text-sm text-theme-200 outline-none transition placeholder:text-theme-600 focus:border-accent-500/60 focus:ring-2 focus:ring-accent-500/10"
            >
            <button
              v-if="searchQuery"
              type="button"
              class="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-theme-500 hover:text-theme-200"
              aria-label="Clear search"
              @click="searchQuery = ''"
            >
              <Icon
                icon="lucide:x"
                class="h-3.5 w-3.5"
              />
            </button>
          </label>
          <label
            v-if="hasAnyAgents"
            class="min-w-0 shrink-0"
          >
            <span class="sr-only">Filter agents by state</span>
            <select
              v-model="stateFilter"
              aria-label="Filter agents by state"
              class="h-10 rounded-xl border border-theme-700 bg-theme-950/70 px-3 text-sm text-theme-300 outline-none focus:border-accent-500/60 focus:ring-2 focus:ring-accent-500/10"
            >
              <option value="all">All states</option>
              <option value="ready">Ready</option>
              <option value="warning">Needs attention</option>
            </select>
          </label>
          <button
            class="flex h-10 shrink-0 items-center gap-2 rounded-lg bg-accent-600 px-4 text-sm font-medium text-white hover:bg-accent-500"
            @click="showCreateDialog = true"
          >
            <Icon
              icon="lucide:plus"
              class="h-4 w-4"
            /> New Agent
          </button>
        </div>
      </div>
    </header>

    <div class="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
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
        :items="filteredTableAgents"
        :columns="agentColumns"
        :filter-text="searchQuery"
        :filter-predicate="matchesSearch"
        selectable
        pagination
        :page-size="30"
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
                  v-if="agentIssues.get(item.id)?.length"
                  icon="lucide:alert-triangle"
                  class="h-3.5 w-3.5 shrink-0 text-amber-400"
                  :title="agentIssues.get(item.id)?.join('\n')"
                  :aria-label="`Unavailable assignments: ${agentIssues.get(item.id)?.join(', ')}`"
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
                :class="item.autoToolRouting ? 'bg-emerald-500/15 text-emerald-400' : 'bg-theme-700/50 text-theme-500'"
              ><Icon
                icon="lucide:wrench"
                class="h-3 w-3"
              />{{ item.tools.length }}</span>
              <template #content>
                <div
                  class="mb-2 font-medium"
                  :class="item.autoToolRouting ? 'text-emerald-400' : 'text-theme-400'"
                >
                  Automatic tool discovery is {{ item.autoToolRouting ? 'enabled' : 'disabled' }}
                </div>
                <div v-if="toolNamespaces(item).mcps.length">
                  <div class="mb-1 font-medium text-theme-400">
                    MCPs
                  </div>
                  <div
                    v-for="namespace in toolNamespaces(item).mcps"
                    :key="namespace.id"
                    class="flex items-center gap-1.5 py-0.5 text-[10px] text-theme-300"
                  >
                    <span class="flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded bg-theme-800">
                      <img
                        v-if="namespaceIcon(namespace.id)"
                        :src="namespaceIcon(namespace.id)!"
                        alt=""
                        class="h-3.5 w-3.5 object-contain"
                        @error="markIconBroken(namespace.id)"
                      >
                      <Icon
                        v-else
                        icon="lucide:plug"
                        class="h-3 w-3 text-theme-400"
                      />
                    </span>
                    <span class="truncate">{{ namespace.label }}</span>
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
                class="flex items-center rounded px-1.5 py-1"
                :class="item.autoMemory ? 'bg-emerald-500/15 text-emerald-400' : 'bg-theme-700/50 text-theme-600'"
              ><Icon
                icon="lucide:database"
                class="h-3 w-3"
              /></span>
              <template #content>
                <div
                  class="font-medium"
                  :class="item.autoMemory ? 'text-emerald-400' : 'text-theme-400'"
                >
                  Auto memory is {{ item.autoMemory ? 'enabled' : 'disabled' }}
                </div>
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

      <BaseCard
        v-else
        class="p-12 text-center"
        aria-labelledby="agents-empty-title"
      >
        <div class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-theme-800">
          <Icon
            icon="lucide:bot"
            class="h-8 w-8 text-theme-600"
          />
        </div>
        <h3
          id="agents-empty-title"
          class="mb-2 text-lg font-medium text-theme-200"
        >
          No agents yet
        </h3>
        <p class="mx-auto mb-4 max-w-md text-sm text-theme-500">
          Create an agent with the model, instructions, and tools for the way you work.
        </p>
        <button
          class="inline-flex items-center gap-2 rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-500"
          @click="showCreateDialog = true"
        >
          <Icon
            icon="lucide:plus"
            class="h-4 w-4"
          />
          Create Agent
        </button>
      </BaseCard>
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
