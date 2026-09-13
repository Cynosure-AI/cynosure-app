<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { useAgentStore } from '../stores/agent-runtime.store'
import { useProviderStore } from '../stores/provider.store'
import { useProviderLogos } from '../composables/useProviderLogos'
import BaseCard from '../components/shared/BaseCard.vue'
import DataTable from '../components/shared/DataTable.vue'
import HoverTooltip from '../components/shared/HoverTooltip.vue'
import ModalDialog from '../components/shared/ModalDialog.vue'
import MultiSelect from '../components/shared/MultiSelect.vue'
import ProviderModelSelect from '../components/shared/ProviderModelSelect.vue'
import TagInput from '../components/shared/TagInput.vue'
import type { Column } from '../components/shared/DataTable.vue'
import type { MultiSelectOption } from '../components/shared/MultiSelect.vue'
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
const selectedTags = ref<string[]>([])
const selectedAgentIds = ref<string[]>([])
const activeSortKey = ref<string | null>(null)
const editProviderId = ref('')
const editModel = ref('')
const editTags = ref<string[]>([])
const editTagOperation = ref<'add' | 'remove' | 'replace'>('add')
const editSaving = ref(false)
const dragReorderId = ref<string | null>(null)
const dropTargetId = ref<string | null>(null)
const dropPosition = ref<'before' | 'after'>('before')

onMounted(() => agentDefs.load())

const allTags = computed(() => {
  const tags = new Map<string, string>()
  for (const agent of agentDefs.agents) {
    for (const tag of agent.tags || []) {
      const key = tag.toLocaleLowerCase()
      if (!tags.has(key)) tags.set(key, tag)
    }
  }
  return [...tags.values()].sort((a, b) => a.localeCompare(b))
})
const tagFilterOptions = computed<MultiSelectOption[]>(() => allTags.value.map(tag => ({ value: tag, label: tag })))

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
function matchesSelectedTags(agent: AgentDefinition): boolean {
  if (!selectedTags.value.length) return true
  const tags = new Set((agent.tags || []).map(tag => tag.toLocaleLowerCase()))
  return selectedTags.value.every(tag => tags.has(tag.toLocaleLowerCase()))
}
function matchesSearch(agent: AgentDefinition, query: string): boolean {
  return [agent.name, agent.description || '', agent.model || '', getProviderName(agent), ...(agent.tags || [])]
    .some(value => value.toLocaleLowerCase().includes(query))
}
function defaultAgentSort(a: AgentDefinition, b: AgentDefinition): number {
  if (a.favorite !== b.favorite) return a.favorite ? -1 : 1
  return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name)
}

const tableAgents = computed(() => [...agentDefs.agents].filter(matchesSelectedTags).sort(defaultAgentSort))
const hasAnyAgents = computed(() => agentDefs.agents.length > 0)
const hasFilters = computed(() => Boolean(searchQuery.value.trim()) || selectedTags.value.length > 0)
const agentColumns: Column<AgentDefinition>[] = [
  { key: 'favorite', label: '', width: '36px', sortable: true, sortValue: agent => agent.favorite },
  { key: 'name', label: 'Name', width: 'minmax(240px, 1.45fr)', sortable: true, sortValue: agent => agent.name },
  { key: 'tags', label: 'Tags', width: 'minmax(210px, 1fr)', sortable: true, editable: true, sortValue: agent => (agent.tags || []).join(' ') },
  { key: 'model', label: 'Model / Provider', width: 'minmax(240px, 1.1fr)', sortable: true, editable: true, sortValue: agent => `${getModelDisplayName(agent)}\u0000${getProviderName(agent)}` },
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

function toggleTagFilter(tag: string): void {
  const key = tag.toLocaleLowerCase()
  selectedTags.value = selectedTags.value.some(item => item.toLocaleLowerCase() === key)
    ? selectedTags.value.filter(item => item.toLocaleLowerCase() !== key)
    : [...selectedTags.value, tag]
}
function isTagSelected(tag: string): boolean {
  return selectedTags.value.some(item => item.toLocaleLowerCase() === tag.toLocaleLowerCase())
}
function clearFilters(): void {
  searchQuery.value = ''
  selectedTags.value = []
}
function applyTagOperation(current: string[], selected: string[], operation: 'add' | 'remove' | 'replace'): string[] {
  if (operation === 'replace') return [...selected]
  const selectedKeys = new Set(selected.map(tag => tag.toLocaleLowerCase()))
  if (operation === 'remove') return current.filter(tag => !selectedKeys.has(tag.toLocaleLowerCase()))
  const result = [...current]
  const resultKeys = new Set(result.map(tag => tag.toLocaleLowerCase()))
  for (const tag of selected) {
    if (!resultKeys.has(tag.toLocaleLowerCase())) {
      result.push(tag)
      resultKeys.add(tag.toLocaleLowerCase())
    }
  }
  return result
}

function startInlineEdit(item: AgentDefinition, column: Column<AgentDefinition>, items: AgentDefinition[]): void {
  editSaving.value = false
  if (column.key === 'model') {
    editProviderId.value = item.providerId
    editModel.value = item.model
  } else if (column.key === 'tags') {
    editTagOperation.value = items.length > 1 ? 'add' : 'replace'
    editTags.value = items.length > 1 ? [] : [...(item.tags || [])]
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
async function saveInlineTags(items: AgentDefinition[], finish: () => void): Promise<void> {
  const invalid = items.length > 1 && editTagOperation.value !== 'replace' && !editTags.value.length
  if (editSaving.value || invalid) return
  editSaving.value = true
  try {
    await Promise.all(items.map(agent => agentDefs.update(agent.id, {
      tags: items.length === 1 ? [...editTags.value] : applyTagOperation(agent.tags || [], editTags.value, editTagOperation.value),
    })))
    finish()
  } finally { editSaving.value = false }
}

async function createAgent(): Promise<void> {
  if (!newName.value.trim()) return
  const agent = await agentDefs.create({
    name: newName.value.trim(), internalName: '', description: newDescription.value.trim(), category: '', tags: [],
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
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  dropPosition.value = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
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
  let toIndex = list.findIndex(agent => agent.id === targetId)
  if (fromIndex < 0 || toIndex < 0) return
  const [moved] = list.splice(fromIndex, 1)
  if (fromIndex < toIndex) toIndex--
  if (dropPosition.value === 'after') toIndex++
  list.splice(toIndex, 0, moved)
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
            Create and manage AI agents with custom configurations, tags, and favorites.
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

      <div class="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center">
        <div class="relative min-w-0 flex-1">
          <Icon
            icon="lucide:search"
            class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-500"
          />
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Search agents, tags, providers, or models..."
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
        <MultiSelect
          v-model="selectedTags"
          class="w-full lg:w-64"
          :options="tagFilterOptions"
          placeholder="Filter by tags..."
          max-height="max-h-96"
        />
      </div>

      <div
        v-if="selectedTags.length"
        class="mb-4 flex flex-wrap items-center gap-2"
      >
        <button
          v-for="tag in selectedTags"
          :key="tag"
          class="rounded-full border border-accent-500/70 bg-accent-500/15 px-2.5 py-1 text-xs text-accent-300"
          :title="`Remove ${tag} filter`"
          @click="toggleTagFilter(tag)"
        >
          {{ tag }}
        </button>
        <button
          class="rounded-full px-2.5 py-1 text-xs text-theme-500 hover:bg-theme-800 hover:text-theme-300"
          @click="selectedTags = []"
        >
          Clear tags
        </button>
      </div>

      <div
        v-if="selectedAgentIds.length"
        class="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-accent-500/25 bg-accent-500/8 px-3 py-2"
      >
        <p class="text-xs text-theme-400">
          <span class="font-medium text-theme-200">{{ selectedAgentIds.length }} selected.</span> Double-click a Tags or Model cell to edit all selected agents.
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
        :items="tableAgents"
        :columns="agentColumns"
        :filter-text="searchQuery"
        :filter-predicate="matchesSearch"
        selectable
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
        <template #col-tags="{ item }">
          <div class="flex flex-wrap items-center gap-1.5 pr-4">
            <span
              v-for="tag in item.tags"
              :key="tag"
              class="rounded-full border px-2 py-0.5 text-xs"
              :class="isTagSelected(tag) ? 'border-accent-500/70 bg-accent-500/15 text-accent-300' : 'border-theme-700 bg-theme-900/70 text-theme-400'"
            >{{ tag }}</span>
            <span
              v-if="!item.tags.length"
              class="text-xs text-theme-600"
            >No tags</span>
          </div>
        </template>
        <template #edit-col-tags="{ items, finish, cancel }">
          <div
            v-if="items.length > 1"
            class="mb-3 grid grid-cols-3 rounded-lg bg-theme-950/70 p-1"
            role="group"
            aria-label="Tag operation"
          >
            <button
              v-for="operation in (['add', 'remove', 'replace'] as const)"
              :key="operation"
              type="button"
              class="rounded-md px-2 py-1.5 text-xs capitalize"
              :class="editTagOperation === operation ? 'bg-theme-700 text-theme-100 shadow-sm' : 'text-theme-500 hover:text-theme-300'"
              @click="editTagOperation = operation"
            >
              {{ operation }}
            </button>
          </div>
          <TagInput
            v-model="editTags"
            :suggestions="allTags"
            :placeholder="items.length === 1 || editTagOperation === 'replace' ? 'Replacement tags' : `Tags to ${editTagOperation}`"
            input-class="py-1.5"
          />
          <p
            v-if="items.length > 1 && editTagOperation === 'replace' && !editTags.length"
            class="mt-2 text-[11px] text-amber-400/80"
          >
            Saving will clear all tags from the selected agents.
          </p>
          <div class="mt-3 flex justify-end gap-2">
            <button
              class="rounded-md px-3 py-1.5 text-xs text-theme-400 hover:bg-theme-800"
              @click="cancel"
            >
              Cancel
            </button>
            <button
              class="rounded-md bg-accent-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-500 disabled:opacity-50"
              :disabled="editSaving || (items.length > 1 && editTagOperation !== 'replace' && !editTags.length)"
              @click="saveInlineTags(items, finish)"
            >
              {{ editSaving ? 'Saving…' : 'Save' }}
            </button>
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
              <div class="truncate text-sm font-medium text-theme-200">
                {{ getModelDisplayName(item) }}
              </div><div class="truncate text-xs text-theme-500">
                {{ getProviderName(item) }}
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
              :disabled="item.tools.length === 0"
              placement="mouse"
              :max-width="220"
            >
              <span class="flex items-center gap-1 rounded bg-theme-700/50 px-1.5 py-0.5"><Icon
                icon="lucide:wrench"
                class="h-3 w-3"
              />{{ item.tools.length }}</span>
              <template #content>
                <div class="mb-1.5 font-medium text-theme-300">
                  {{ item.tools.length }} {{ item.tools.length === 1 ? 'tool' : 'tools' }}
                </div><div
                  v-for="key in item.tools.slice(0, TOOLTIP_MAX_TOOLS)"
                  :key="key"
                  class="truncate py-0.5 font-mono text-[10px] text-theme-300"
                >
                  {{ agentStore.availableTools.find(tool => tool.key === key)?.name ?? key }}
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
      >
        <div class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent-500/10">
          <Icon
            icon="lucide:bot"
            class="h-8 w-8 text-accent-400"
          />
        </div>
        <h3 class="mb-2 text-lg font-medium text-theme-200">
          No Agents Yet
        </h3>
        <p class="mx-auto mb-6 max-w-md text-sm text-theme-500">
          Create your first agent to get started. Each agent can be configured with its own model, tools, memory, and tags.
        </p>
        <button
          class="inline-flex items-center gap-2 rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white hover:bg-accent-500"
          @click="showCreateDialog = true"
        >
          <Icon
            icon="lucide:plus"
            class="h-4 w-4"
          />Create Agent
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
