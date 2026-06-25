<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { useAgentStore } from '../stores/agent-runtime.store'
import { useProviderStore } from '../stores/provider.store'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import BaseCard from '../components/shared/BaseCard.vue'
import ModalDialog from '../components/shared/ModalDialog.vue'
import HoverTooltip from '../components/shared/HoverTooltip.vue'
import ProviderModelSelect from '../components/shared/ProviderModelSelect.vue'
import TagInput from '../components/shared/TagInput.vue'
import MultiSelect from '../components/shared/MultiSelect.vue'
import type { MultiSelectOption } from '../components/shared/MultiSelect.vue'
import { useProviderLogos } from '../composables/useProviderLogos'
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

const bulkSelectionIds = ref<string[]>([])
const bulkProviderId = ref('')
const bulkModel = ref('')
const bulkTags = ref<string[]>([])
const hasBulkProviderModelSelection = ref(false)
const hasBulkTagsSelection = ref(false)

const dragReorderId = ref<string | null>(null)
const dropTargetId = ref<string | null>(null)
const dropPosition = ref<'before' | 'after'>('before')

onMounted(() => agentDefs.load())

const allTags = computed(() => {
  const tagMap = new Map<string, string>()
  for (const agent of agentDefs.agents) {
    for (const tag of agent.tags || []) {
      const key = tag.toLowerCase()
      if (!tagMap.has(key)) tagMap.set(key, tag)
    }
  }
  return [...tagMap.values()].sort((a, b) => a.localeCompare(b))
})

const tagFilterOptions = computed<MultiSelectOption[]>(() =>
  allTags.value.map(tag => ({ value: tag, label: tag }))
)

function agentSort(a: AgentDefinition, b: AgentDefinition): number {
  if (a.favorite !== b.favorite) return a.favorite ? -1 : 1
  return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name)
}

function matchesSearch(agent: AgentDefinition): boolean {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return true
  return [
    agent.name,
    agent.description || '',
    agent.model || '',
    getProviderName(agent),
    ...(agent.tags || []),
  ].some(value => value.toLowerCase().includes(q))
}

function matchesSelectedTags(agent: AgentDefinition): boolean {
  if (!selectedTags.value.length) return true
  const agentTags = new Set((agent.tags || []).map(tag => tag.toLowerCase()))
  return selectedTags.value.every(tag => agentTags.has(tag.toLowerCase()))
}

const visibleAgents = computed(() =>
  [...agentDefs.agents]
    .filter(matchesSearch)
    .filter(matchesSelectedTags)
    .sort(agentSort)
)

const hasAnyAgents = computed(() => agentDefs.agents.length > 0)
const hasFilters = computed(() => Boolean(searchQuery.value.trim()) || selectedTags.value.length > 0)

const agentsWithIssues = computed(() => {
  const availableKeys = new Set(agentStore.availableTools.map(t => t.key))
  const allAgentIds = new Set(agentDefs.agents.map(a => a.id))
  const isToolMissing = (t: string) => !availableKeys.has(t)
  return new Set(
    agentDefs.agents
      .filter(a => {
        const hasMissingTools = a.tools.some(isToolMissing)
        const hasMissingSubAgents = (a.subAgents || []).some(sa => !allAgentIds.has(sa.agentId))
        return hasMissingTools || hasMissingSubAgents
      })
      .map(a => a.id)
  )
})

const isBulkMode = computed(() => bulkSelectionIds.value.length > 0)
const selectedAgentCount = computed(() => bulkSelectionIds.value.length)
const selectedBulkAgents = computed(() => {
  const selectedIds = new Set(bulkSelectionIds.value)
  return agentDefs.agents.filter(agent => selectedIds.has(agent.id))
})

function isAgentSelected(agentId: string): boolean {
  return bulkSelectionIds.value.includes(agentId)
}

function getProviderName(agent: AgentDefinition): string {
  const provider = providerStore.providers.find(p => p.id === agent.providerId)
  return provider ? provider.name : 'Unknown'
}

function getModelDisplayName(agent: AgentDefinition): string {
  if (!agent.model) return 'No model selected'
  const parts = agent.model.split('/').filter(Boolean)
  return parts.at(-1) || agent.model
}

function getProviderLogoUrl(agent: AgentDefinition): string | null {
  const provider = providerStore.providers.find(p => p.id === agent.providerId)
  if (!provider) return null
  return logoUrl(provider.type)
}

function clearBulkSelection(): void {
  bulkSelectionIds.value = []
  bulkProviderId.value = ''
  bulkModel.value = ''
  bulkTags.value = []
  hasBulkProviderModelSelection.value = false
  hasBulkTagsSelection.value = false
}

function tagsForSelectedAgents(): string[] {
  const tagMap = new Map<string, string>()
  for (const agent of selectedBulkAgents.value) {
    for (const tag of agent.tags || []) {
      const key = tag.toLowerCase()
      if (!tagMap.has(key)) tagMap.set(key, tag)
    }
  }
  return [...tagMap.values()].sort((a, b) => a.localeCompare(b))
}

watch(bulkSelectionIds, () => {
  if (!hasBulkTagsSelection.value) {
    bulkTags.value = tagsForSelectedAgents()
  }
})

function toggleAgentSelection(agentId: string, selected?: boolean): void {
  const current = new Set(bulkSelectionIds.value)
  const shouldSelect = selected ?? !current.has(agentId)
  if (shouldSelect) current.add(agentId)
  else current.delete(agentId)
  bulkSelectionIds.value = [...current]
  if (bulkSelectionIds.value.length === 0) clearBulkSelection()
}

function onRowClick(agentId: string): void {
  if (isBulkMode.value) {
    toggleAgentSelection(agentId)
    return
  }
  router.push(`/agents/${agentId}`)
}

function toggleTag(tag: string): void {
  const key = tag.toLowerCase()
  selectedTags.value = selectedTags.value.some(item => item.toLowerCase() === key)
    ? selectedTags.value.filter(item => item.toLowerCase() !== key)
    : [...selectedTags.value, tag]
}

function isTagSelected(tag: string): boolean {
  return selectedTags.value.some(item => item.toLowerCase() === tag.toLowerCase())
}

function clearFilters(): void {
  searchQuery.value = ''
  selectedTags.value = []
}

async function applyBulkChanges(): Promise<void> {
  if (!isBulkMode.value || (!hasBulkProviderModelSelection.value && !hasBulkTagsSelection.value)) return
  const ids = [...bulkSelectionIds.value]
  await Promise.all(ids.map(id => {
    const updates: Partial<Omit<AgentDefinition, 'id' | 'createdAt' | 'updatedAt'>> = {}
    if (hasBulkProviderModelSelection.value) {
      updates.providerId = bulkProviderId.value
      updates.model = bulkModel.value
    }
    if (hasBulkTagsSelection.value) {
      updates.tags = [...bulkTags.value]
    }
    return agentDefs.update(id, updates)
  }))
  clearBulkSelection()
}

function updateBulkTags(tags: string[]): void {
  bulkTags.value = tags
  hasBulkTagsSelection.value = true
}

async function createAgent() {
  if (!newName.value.trim()) return
  const agent = await agentDefs.create({
    name: newName.value.trim(),
    internalName: '',
    description: newDescription.value.trim(),
    category: '',
    tags: [],
    favorite: false,
    iconUrl: null,
    providerId: providerStore.lastUsedProviderId || '',
    model: providerStore.lastUsedProvider?.defaultModel || '',
    systemPrompt: '',
    cronPrompt: '',
    tools: [],
    autoApproveTools: false,
    autoToolRouting: false,
    autoMemory: true,
    generateTitle: true
  })
  showCreateDialog.value = false
  newName.value = ''
  newDescription.value = ''
  router.push(`/agents/${agent.id}`)
}

async function deleteAgent(id: string) {
  await agentDefs.remove(id)
  showDeleteConfirm.value = false
  pendingDeleteId.value = null
}

function confirmDelete(agent: { id: string; name: string }) {
  pendingDeleteId.value = agent.id
  pendingDeleteName.value = agent.name
  showDeleteConfirm.value = true
}

async function duplicateAgent(id: string) {
  await agentDefs.duplicate(id)
}

async function toggleFavorite(agent: AgentDefinition): Promise<void> {
  await agentDefs.update(agent.id, { favorite: !agent.favorite })
}

function onReorderDragStart(e: DragEvent, agentId: string) {
  dragReorderId.value = agentId
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', agentId)
  }
}

function onReorderDragOver(e: DragEvent, targetId: string) {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  if (!dragReorderId.value || dragReorderId.value === targetId) {
    dropTargetId.value = null
    return
  }

  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  dropPosition.value = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
  dropTargetId.value = targetId
}

function onReorderDragLeave(e: DragEvent, targetId: string) {
  const related = e.relatedTarget as HTMLElement | null
  const current = e.currentTarget as HTMLElement
  if (!related || !current.contains(related)) {
    if (dropTargetId.value === targetId) dropTargetId.value = null
  }
}

async function onReorderDrop(e: DragEvent, targetAgentId: string) {
  e.preventDefault()
  const draggedId = dragReorderId.value
  dragReorderId.value = null
  dropTargetId.value = null
  if (!draggedId || draggedId === targetAgentId) return

  const list = [...visibleAgents.value]
  const fromIdx = list.findIndex(agent => agent.id === draggedId)
  let toIdx = list.findIndex(agent => agent.id === targetAgentId)
  if (fromIdx === -1 || toIdx === -1) return

  const [moved] = list.splice(fromIdx, 1)
  if (fromIdx < toIdx) toIdx--
  if (dropPosition.value === 'after') toIdx++
  list.splice(toIdx, 0, moved)

  for (let i = 0; i < list.length; i++) {
    if (list[i].sortOrder !== i) {
      await agentDefs.update(list[i].id, { sortOrder: i })
    }
  }
}

function onReorderDragEnd() {
  dragReorderId.value = null
  dropTargetId.value = null
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
}
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-6xl mx-auto py-8 px-6">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold text-theme-100">
            Agents
          </h1>
          <p class="text-sm text-theme-500 mt-1">
            Create and manage AI agents with custom configurations, tags, and favorites.
          </p>
        </div>
        <button
          class="flex items-center gap-2 px-4 py-2 bg-accent-600 hover:bg-accent-500 text-white rounded-lg text-sm font-medium transition-colors"
          @click="showCreateDialog = true"
        >
          <Icon
            icon="lucide:plus"
            class="w-4 h-4"
          />
          New Agent
        </button>
      </div>

      <div class="flex flex-col gap-3 mb-5 lg:flex-row lg:items-center">
        <div class="relative flex-1 flex items-center gap-2">
          <Icon
            icon="lucide:search"
            class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-theme-500"
          />
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Search agents, tags, providers, or models..."
            class="w-full pl-10 pr-9 py-2 bg-theme-800/60 border border-theme-700/60 rounded-lg text-sm text-theme-200 placeholder:text-theme-600 focus:outline-none focus:ring-1 focus:ring-accent-500/60 focus:border-accent-500/40 transition-colors"
          >
          <MultiSelect
            v-model="selectedTags"
            class=" max-w-3xs"
            :options="tagFilterOptions"
            placeholder="Filter by tags..."
          />
          <button
            v-if="searchQuery"
            class="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-theme-500 hover:text-theme-300 transition-colors"
            @click="searchQuery = ''"
          >
            <Icon
              icon="lucide:x"
              class="w-4 h-4"
            />
          </button>
        </div>
      </div>

      <div
        v-if="allTags.length"
        class="mb-5 flex flex-col gap-2 sm:flex-row sm:items-center"
      >
        <div
          v-if="selectedTags.length"
          class="flex flex-wrap items-center gap-2"
        >
          <button
            v-for="tag in selectedTags"
            :key="tag"
            class="rounded-full border border-accent-500/70 bg-accent-500/15 px-2.5 py-1 text-xs text-accent-300 transition-colors hover:border-accent-400 hover:text-accent-200"
            :title="`Remove ${tag} filter`"
            @click="toggleTag(tag)"
          >
            {{ tag }}
          </button>
          <button
            class="rounded-full px-2.5 py-1 text-xs text-theme-500 hover:bg-theme-800 hover:text-theme-300 transition-colors"
            @click="selectedTags = []"
          >
            Clear tags
          </button>
        </div>
      </div>

      <div
        v-if="isBulkMode"
        class="mb-5 flex flex-col gap-3 rounded-xl border border-accent-500/30 bg-accent-500/8 px-4 py-3 md:flex-row md:items-center md:justify-between"
      >
        <div class="text-sm text-theme-200">
          {{ selectedAgentCount }} agent{{ selectedAgentCount === 1 ? '' : 's' }} selected
        </div>
        <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-end md:flex-1">
          <div class="min-w-0 md:min-w-72">
            <TagInput
              :model-value="bulkTags"
              :suggestions="allTags"
              placeholder="Set tags for selected agents"
              input-class="py-1.5"
              @update:model-value="updateBulkTags"
            />
          </div>
          <div class="min-w-0 md:min-w-80">
            <ProviderModelSelect
              :provider-id="bulkProviderId"
              :model-value="bulkModel"
              :providers="providerStore.providers"
              :model-types="['llm', 'image', 'video', 'transcription']"
              placeholder="Set model for selected agents"
              size="sm"
              dropdown-width="w-[28rem]"
              @update:provider-id="bulkProviderId = $event"
              @update:model-value="bulkModel = $event"
              @change="hasBulkProviderModelSelection = Boolean($event.providerId)"
            />
          </div>
          <div class="flex items-center gap-2">
            <button
              class="px-3 py-2 rounded-lg bg-accent-600 hover:bg-accent-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
              :disabled="!hasBulkProviderModelSelection && !hasBulkTagsSelection"
              @click="applyBulkChanges"
            >
              Apply
            </button>
            <button
              class="px-3 py-2 rounded-lg bg-theme-800 hover:bg-theme-700 text-theme-300 text-sm font-medium transition-colors"
              @click="clearBulkSelection"
            >
              Clear
            </button>
          </div>
        </div>
      </div>

      <div
        v-if="hasAnyAgents"
        class="flex flex-col rounded-xl border border-theme-800 overflow-hidden bg-theme-950/45"
      >
        <div class="agent-grid bg-theme-900/70 border-b border-theme-800 px-5 py-3 text-[11px] tracking-wider uppercase text-theme-400">
          <div class="flex items-center" />
          <div>Name</div>
          <div class="hidden md:block">
            Tags
          </div>
          <div class="hidden lg:block">
            Model/Provider
          </div>
          <div class="hidden xl:block">
            Info
          </div>
          <div class="text-right">
            Actions
          </div>
        </div>

        <div
          v-for="item in visibleAgents"
          :key="item.id"
          class="agent-grid group border-b border-theme-800/70 last:border-b-0 cursor-pointer hover:bg-theme-800/30 transition-colors px-5 py-4"
          @click="onRowClick(item.id)"
        >
          <div
            class="flex items-center gap-2 pt-1"
            @click.stop
          >
            <input
              type="checkbox"
              class="h-4 w-4 rounded border-theme-600 bg-theme-900 text-accent-500 focus:ring-accent-500/60 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
              :class="{ 'opacity-100': isBulkMode || isAgentSelected(item.id) }"
              :checked="isAgentSelected(item.id)"
              @change="toggleAgentSelection(item.id, ($event.target as HTMLInputElement).checked)"
            >
            <button
              class="rounded-md p-1 transition-colors"
              :class="item.favorite ? 'text-amber-400 hover:text-amber-300 [&>svg]:fill-current' : 'text-theme-600 hover:text-amber-400'"
              :title="item.favorite ? 'Remove from favorites' : 'Add to favorites'"
              @click="toggleFavorite(item)"
            >
              <Icon
                icon="lucide:star"
                class="h-4 w-4"
              />
            </button>
          </div>

          <div
            class="flex items-start gap-3 min-w-0 cursor-grab active:cursor-grabbing"
            :class="{
              'opacity-60': dragReorderId === item.id,
              'ring-1 ring-accent-500/70 ring-inset rounded-lg': dropTargetId === item.id,
            }"
            draggable="true"
            @dragstart="onReorderDragStart($event, item.id)"
            @dragover="onReorderDragOver($event, item.id)"
            @dragleave="onReorderDragLeave($event, item.id)"
            @drop="onReorderDrop($event, item.id)"
            @dragend="onReorderDragEnd"
          >
            <div class="w-9 h-9 shrink-0 rounded-lg bg-linear-to-br from-accent-500/20 to-purple-500/20 flex items-center justify-center overflow-hidden">
              <img
                v-if="item.iconUrl"
                :src="item.iconUrl"
                alt=""
                class="w-full h-full object-cover"
              >
              <Icon
                v-else
                icon="lucide:bot"
                class="w-4 h-4 text-accent-400"
              />
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium text-theme-100 truncate flex items-center gap-1">
                {{ item.name }}
                <Icon
                  v-if="agentsWithIssues.has(item.id)"
                  icon="lucide:alert-triangle"
                  class="w-3.5 h-3.5 text-amber-400 shrink-0"
                />
              </div>
              <div
                v-if="item.description"
                class="text-xs text-theme-500 truncate"
              >
                {{ item.description }}
              </div>
              <div class="mt-2 flex flex-wrap gap-1 md:hidden">
                <button
                  v-for="tag in item.tags"
                  :key="tag"
                  class="rounded-full border border-theme-700 bg-theme-900/70 px-2 py-0.5 text-[11px] text-theme-400"
                  @click.stop="toggleTag(tag)"
                >
                  {{ tag }}
                </button>
              </div>
            </div>
          </div>

          <div class="hidden md:flex flex-wrap items-center gap-1.5">
            <button
              v-for="tag in item.tags"
              :key="tag"
              class="rounded-full border px-2 py-0.5 text-xs transition-colors"
              :class="isTagSelected(tag)
                ? 'border-accent-500/70 bg-accent-500/15 text-accent-300'
                : 'border-theme-700 bg-theme-900/70 text-theme-400 hover:border-theme-600 hover:text-theme-200'"
              @click.stop="toggleTag(tag)"
            >
              {{ tag }}
            </button>
            <span
              v-if="!item.tags.length"
              class="text-xs text-theme-600"
            >
              No tags
            </span>
          </div>

          <div class="hidden lg:flex items-center gap-2 md:pt-1">
            <img
              v-if="getProviderLogoUrl(item)"
              :src="getProviderLogoUrl(item) || ''"
              :alt="getProviderName(item)"
              class="w-5 h-5 rounded object-contain shrink-0"
            >
            <div class="flex flex-col gap-0.5 min-w-0">
              <div class="text-sm text-theme-200 font-medium">
                {{ getModelDisplayName(item) }}
              </div>
              <div class="text-xs text-theme-500 truncate">
                {{ getProviderName(item) }}
              </div>
            </div>
          </div>

          <div class="hidden xl:flex items-center gap-3 text-xs text-theme-500">
            <HoverTooltip
              :disabled="item.tools.length === 0"
              placement="mouse"
              :max-width="220"
            >
              <span
                class="flex items-center gap-1 bg-theme-700/50 px-1.5 py-0.5 rounded"
                :class="item.tools.length > 0 ? 'cursor-default' : ''"
              >
                <Icon
                  icon="lucide:wrench"
                  class="w-3 h-3"
                />
                {{ item.tools.length }}
              </span>
              <template #content>
                <div class="font-medium text-theme-300 mb-1.5">
                  {{ item.tools.length }} {{ item.tools.length === 1 ? 'tool' : 'tools' }}
                </div>
                <div
                  v-for="key in item.tools.slice(0, TOOLTIP_MAX_TOOLS)"
                  :key="key"
                  class="font-mono text-[10px] text-theme-300 truncate py-0.5"
                >
                  {{ agentStore.availableTools.find(t => t.key === key)?.name ?? key }}
                </div>
                <div
                  v-if="item.tools.length > TOOLTIP_MAX_TOOLS"
                  class="text-theme-500 text-[10px] mt-1"
                >
                  +{{ item.tools.length - TOOLTIP_MAX_TOOLS }} more
                </div>
              </template>
            </HoverTooltip>
            <HoverTooltip
              :disabled="!item.subAgents?.length"
              placement="mouse"
              :max-width="220"
            >
              <span
                class="flex items-center gap-1 bg-theme-700/50 px-1.5 py-0.5 rounded"
                :class="item.subAgents?.length ? 'cursor-default' : ''"
              >
                <Icon
                  icon="lucide:users"
                  class="w-3 h-3"
                />
                {{ item.subAgents?.length || 0 }}
              </span>
              <template #content>
                <div class="font-medium text-theme-300 mb-1.5">
                  {{ item.subAgents?.length }} {{ item.subAgents?.length === 1 ? 'sub-agent' : 'sub-agents' }}
                </div>
                <div
                  v-for="sa in item.subAgents?.slice(0, TOOLTIP_MAX_TOOLS)"
                  :key="sa.agentId"
                  class="text-[10px] text-theme-300 truncate py-0.5"
                >
                  {{ agentDefs.get(sa.agentId)?.name ?? sa.agentId }}
                </div>
                <div
                  v-if="(item.subAgents?.length || 0) > TOOLTIP_MAX_TOOLS"
                  class="text-theme-500 text-[10px] mt-1"
                >
                  +{{ (item.subAgents?.length || 0) - TOOLTIP_MAX_TOOLS }} more
                </div>
              </template>
            </HoverTooltip>
            <span class="flex items-center gap-1 whitespace-nowrap">
              <Icon
                icon="lucide:calendar"
                class="w-3 h-3"
              />
              {{ formatDate(item.createdAt) }}
            </span>
          </div>

          <div class="flex items-center justify-end gap-1">
            <button
              class="p-1.5 text-theme-500 hover:text-accent-400 rounded-md transition-all"
              title="Duplicate agent"
              @click.stop="duplicateAgent(item.id)"
            >
              <Icon
                icon="lucide:copy"
                class="w-4 h-4"
              />
            </button>
            <button
              class="p-1.5 text-theme-500 hover:text-red-400 rounded-md transition-all"
              title="Delete agent"
              @click.stop="confirmDelete(item)"
            >
              <Icon
                icon="lucide:trash-2"
                class="w-4 h-4"
              />
            </button>
          </div>
        </div>

        <div
          v-if="visibleAgents.length === 0"
          class="px-5 py-8 text-center text-sm text-theme-500"
        >
          No agents match the current filters.
        </div>
      </div>

      <BaseCard
        v-if="!hasAnyAgents"
        class="p-12 text-center"
      >
        <div class="w-16 h-16 rounded-2xl bg-accent-500/10 flex items-center justify-center mx-auto mb-4">
          <Icon
            icon="lucide:bot"
            class="w-8 h-8 text-accent-400"
          />
        </div>
        <h3 class="text-lg font-medium text-theme-200 mb-2">
          No Agents Yet
        </h3>
        <p class="text-sm text-theme-500 max-w-md mx-auto mb-6">
          Create your first agent to get started. Each agent can be configured with its own model, tools, memory, and tags.
        </p>
        <button
          class="inline-flex items-center gap-2 px-4 py-2 bg-accent-600 hover:bg-accent-500 text-white rounded-lg text-sm font-medium transition-colors"
          @click="showCreateDialog = true"
        >
          <Icon
            icon="lucide:plus"
            class="w-4 h-4"
          />
          Create Agent
        </button>
      </BaseCard>

      <div
        v-if="hasAnyAgents && hasFilters"
        class="mt-4 flex items-center justify-between text-sm text-theme-500"
      >
        <span>Showing {{ visibleAgents.length }} of {{ agentDefs.agents.length }} agents</span>
        <button
          class="text-theme-400 hover:text-theme-200 transition-colors"
          @click="clearFilters"
        >
          Clear filters
        </button>
      </div>

      <Teleport to="body">
        <div
          v-if="showCreateDialog"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          @click.self="showCreateDialog = false"
        >
          <div class="bg-theme-900 border border-theme-700 rounded-xl p-6 w-full max-w-md shadow-xl">
            <h2 class="text-lg font-semibold text-theme-100 mb-4">
              Create New Agent
            </h2>
            <div class="space-y-4">
              <div>
                <label class="block text-sm text-theme-400 mb-1.5">Name</label>
                <input
                  v-model="newName"
                  type="text"
                  placeholder="My Agent"
                  class="w-full px-3 py-2 bg-theme-800 border border-theme-700 rounded-lg text-sm text-theme-200 placeholder:text-theme-600 focus:outline-none focus:ring-1 focus:ring-accent-500"
                  @keydown.enter="createAgent"
                >
              </div>
              <div>
                <label class="block text-sm text-theme-400 mb-1.5">Description</label>
                <textarea
                  v-model="newDescription"
                  placeholder="What does this agent do?"
                  class="w-full px-3 py-2 bg-theme-800 border border-theme-700 rounded-lg text-sm text-theme-200 placeholder:text-theme-600 focus:outline-none focus:ring-1 focus:ring-accent-500 resize-none h-20"
                />
              </div>
            </div>
            <div class="flex justify-end gap-2 mt-6">
              <button
                class="px-4 py-2 text-sm text-theme-400 hover:text-theme-200 transition-colors"
                @click="showCreateDialog = false"
              >
                Cancel
              </button>
              <button
                class="px-4 py-2 bg-accent-600 hover:bg-accent-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                :disabled="!newName.trim()"
                @click="createAgent"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      </Teleport>

      <ModalDialog
        :show="showDeleteConfirm"
        title="Delete Agent"
        icon="lucide:trash-2"
        icon-color="red"
        @close="showDeleteConfirm = false"
      >
        <p class="text-theme-400 leading-relaxed">
          Are you sure you want to delete <strong class="text-theme-200">{{ pendingDeleteName }}</strong>? This action cannot be undone.
        </p>
        <template #actions>
          <button
            class="w-full px-4 py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl text-center font-medium transition-colors"
            @click="deleteAgent(pendingDeleteId!)"
          >
            Delete Agent
          </button>
          <button
            class="w-full px-4 py-3 bg-theme-800 hover:bg-theme-700 text-theme-300 rounded-xl text-center font-medium transition-colors"
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
.agent-grid {
  display: grid;
  grid-template-columns: 68px minmax(180px, 1.4fr) minmax(150px, 0.9fr) minmax(180px, 0.9fr) 180px 96px;
  gap: 1rem;
  align-items: start;
}

@media (max-width: 1279px) {
  .agent-grid {
    grid-template-columns: 68px minmax(180px, 1.3fr) minmax(150px, 0.9fr) minmax(180px, 0.9fr) 96px;
  }
}

@media (max-width: 1023px) {
  .agent-grid {
    grid-template-columns: 68px minmax(180px, 1fr) minmax(150px, auto) 96px;
  }
}

@media (max-width: 767px) {
  .agent-grid {
    grid-template-columns: 64px minmax(0, 1fr) auto;
    gap: 0.75rem;
  }
}
</style>
