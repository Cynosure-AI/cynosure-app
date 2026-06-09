<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { useAgentStore } from '../stores/agent-runtime.store'
import { useProviderStore } from '../stores/provider.store'
import { usePreferencesStore } from '../stores/preferences.store'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import BaseCard from '../components/shared/BaseCard.vue'
import ModalDialog from '../components/shared/ModalDialog.vue'
import HoverTooltip from '../components/shared/HoverTooltip.vue'
import ProviderModelSelect from '../components/shared/ProviderModelSelect.vue'
import CustomSelect, { type SelectOptionGroup } from '../components/shared/CustomSelect.vue'
import { useProviderLogos } from '../composables/useProviderLogos'
import type { AgentDefinition } from '../api/types'

const agentDefs = useAgentDefinitionsStore()
const agentStore = useAgentStore()
const providerStore = useProviderStore()
const prefs = usePreferencesStore()
const router = useRouter()
const { logoUrl } = useProviderLogos()
const AGENT_IDS_MIME = 'application/x-cynosure-agent-ids'
const AGENT_FOLDER_STATE_KEY = 'cy-agent-folder-collapsed'
const TOOLTIP_MAX_TOOLS = 20

const showCreateDialog = ref(false)
const newName = ref('')
const newDescription = ref('')
const pendingCreateCategory = ref('')

// Delete confirmation
const showDeleteConfirm = ref(false)
const pendingDeleteId = ref<string | null>(null)
const pendingDeleteName = ref('')

const searchQuery = ref('')
const showNewCategoryInput = ref(false)
const newCategoryName = ref('')
const editingCategory = ref<string | null>(null)
const editingCategoryName = ref('')
const knownCategories = ref<Set<string>>(new Set(prefs.agentCategories))
const collapsedCategories = ref<Set<string>>(readCollapsedCategories())
const folderDropTarget = ref<string | null>(null)
const bulkSelectionIds = ref<string[]>([])
const bulkCategory = ref('')
const bulkProviderId = ref('')
const bulkModel = ref('')
const hasBulkProviderModelSelection = ref(false)

const hasUncategorized = computed(() =>
  agentDefs.agents.some(a => !a.category || !prefs.agentCategories.includes(a.category))
)

function readCollapsedCategories(): Set<string> {
  try {
    const raw = sessionStorage.getItem(AGENT_FOLDER_STATE_KEY)
    if (!raw) return new Set(prefs.agentCategories)
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set(prefs.agentCategories)
    return new Set(parsed.filter((category): category is string => typeof category === 'string'))
  } catch {
    return new Set(prefs.agentCategories)
  }
}

function writeCollapsedCategories(categories: Set<string>): void {
  try {
    sessionStorage.setItem(AGENT_FOLDER_STATE_KEY, JSON.stringify([...categories]))
  } catch {
    // Ignore storage errors; in-memory toggle state still works.
  }
}

function sortedAgents(agents: AgentDefinition[]): AgentDefinition[] {
  return [...agents].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
}

function isUncategorizedAgent(agent: AgentDefinition): boolean {
  return !agent.category || !prefs.agentCategories.includes(agent.category)
}

function matchesSearch(agent: AgentDefinition): boolean {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return true
  return agent.name.toLowerCase().includes(q) || (agent.description || '').toLowerCase().includes(q)
}

const uncategorizedAgents = computed(() =>
  sortedAgents(agentDefs.agents.filter(a => isUncategorizedAgent(a) && matchesSearch(a)))
)

const categoryFolders = computed(() =>
  prefs.agentCategories.map(category => ({
    category,
    agents: sortedAgents(agentDefs.agents.filter(a => a.category === category && matchesSearch(a))),
  }))
)

const visibleAgentCount = computed(() =>
  uncategorizedAgents.value.length + categoryFolders.value.reduce((sum, folder) => sum + folder.agents.length, 0)
)

const hasAnyAgents = computed(() => agentDefs.agents.length > 0)

function categoryForAgent(agent: AgentDefinition): string {
  return isUncategorizedAgent(agent) ? '' : agent.category
}

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

const categoryGroups = computed<SelectOptionGroup[]>(() => [
  {
    options: [
      ...(hasUncategorized.value
        ? [{ value: '__uncategorized__', label: 'Uncategorized' }]
        : []),
      ...prefs.agentCategories.map(cat => ({ value: cat, label: cat })),
    ],
  },
])

function isAgentSelected(agentId: string): boolean {
  return bulkSelectionIds.value.includes(agentId)
}

function getProviderName(agent: AgentDefinition): string {
  const provider = providerStore.providers.find(p => p.id === agent.providerId)
  return provider ? provider.name : 'Unknown'
}

function getProviderLogoUrl(agent: AgentDefinition): string | null {
  const provider = providerStore.providers.find(p => p.id === agent.providerId)
  if (!provider) return null
  return logoUrl(provider.type)
}

function clearBulkSelection(): void {
  bulkSelectionIds.value = []
  bulkCategory.value = ''
  bulkProviderId.value = ''
  bulkModel.value = ''
  hasBulkProviderModelSelection.value = false
}

function toggleAgentSelection(agentId: string, selected?: boolean): void {
  const current = new Set(bulkSelectionIds.value)
  const shouldSelect = selected ?? !current.has(agentId)
  if (shouldSelect) current.add(agentId)
  else current.delete(agentId)
  bulkSelectionIds.value = [...current]
  if (bulkSelectionIds.value.length === 0) {
    clearBulkSelection()
  }
}

function areAllAgentsSelected(agents: AgentDefinition[]): boolean {
  return agents.length > 0 && agents.every(agent => isAgentSelected(agent.id))
}

function toggleAgentGroupSelection(agents: AgentDefinition[], selected: boolean): void {
  const current = new Set(bulkSelectionIds.value)
  for (const agent of agents) {
    if (selected) current.add(agent.id)
    else current.delete(agent.id)
  }
  bulkSelectionIds.value = [...current]
  if (bulkSelectionIds.value.length === 0) {
    clearBulkSelection()
  }
}

function onRowClick(agentId: string): void {
  if (isBulkMode.value) {
    toggleAgentSelection(agentId)
    return
  }
  router.push(`/agents/${agentId}`)
}

function draggedAgentIds(agentId: string): string[] {
  if (isBulkMode.value && isAgentSelected(agentId)) {
    return [...bulkSelectionIds.value]
  }
  return [agentId]
}

async function applyBulkChanges(): Promise<void> {
  if (!isBulkMode.value) return
  const ids = [...bulkSelectionIds.value]
  const updates: Partial<Omit<typeof agentDefs.agents[0], 'id' | 'createdAt' | 'updatedAt'>> = {}
  
  if (bulkCategory.value) {
    updates.category = bulkCategory.value === '__uncategorized__' ? '' : bulkCategory.value
  }
  if (hasBulkProviderModelSelection.value) {
    updates.providerId = bulkProviderId.value
    updates.model = bulkModel.value
  }
  
  if (Object.keys(updates).length === 0) return
  await Promise.all(ids.map(id => agentDefs.update(id, updates)))
  clearBulkSelection()
}

onMounted(() => agentDefs.load())

watch(
  () => [...prefs.agentCategories],
  categories => {
    const known = new Set(knownCategories.value)
    const nextCollapsed = new Set(
      [...collapsedCategories.value].filter(category => categories.includes(category))
    )

    for (const category of categories) {
      if (!known.has(category)) {
        nextCollapsed.add(category)
        known.add(category)
      }
    }

    knownCategories.value = new Set([...known].filter(category => categories.includes(category)))
    collapsedCategories.value = nextCollapsed
    writeCollapsedCategories(nextCollapsed)
  }
)

function openCreateDialog(category = ''): void {
  pendingCreateCategory.value = category
  showCreateDialog.value = true
}

async function createAgent() {
  if (!newName.value.trim()) return
  const agent = await agentDefs.create({
    name: newName.value.trim(),
    internalName: '',
    description: newDescription.value.trim(),
    category: pendingCreateCategory.value,
    iconUrl: null,
    providerId: providerStore.lastUsedProviderId || '',
    model: providerStore.lastUsedProvider?.defaultModel || '',
    systemPrompt: '',
    cronPrompt: '',
    tools: [],
    autoApproveTools: false,
    autoToolRouting: false,
    generateTitle: true
  })
  showCreateDialog.value = false
  pendingCreateCategory.value = ''
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

// ─── Drag-and-drop reorder ───────────────────────────────
const dragReorderId = ref<string | null>(null)
const dropTargetId = ref<string | null>(null)
const dropPosition = ref<'before' | 'after'>('before')

function onReorderDragStart(e: DragEvent, agentId: string) {
  dragReorderId.value = agentId
  const draggedIds = draggedAgentIds(agentId)
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', agentId)
    e.dataTransfer.setData(AGENT_IDS_MIME, JSON.stringify(draggedIds))
  }
}

function onReorderDragOver(e: DragEvent, targetId: string) {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  if (!dragReorderId.value || dragReorderId.value === targetId) {
    dropTargetId.value = null
    return
  }

  // Determine drop position based on cursor position within the element
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const midpoint = rect.top + rect.height / 2
  const pos = e.clientY
  dropPosition.value = pos < midpoint ? 'before' : 'after'
  dropTargetId.value = targetId
}

function onReorderDragLeave(e: DragEvent, targetId: string) {
  // Only clear if truly leaving (not entering a child)
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

  const targetAgent = agentDefs.get(targetAgentId)
  if (!targetAgent) return

  const draggedIds = draggedAgentIds(draggedId)
  const targetCategory = categoryForAgent(targetAgent)
  const categoryAgents = agentDefs.agents.filter(a => categoryForAgent(a) === targetCategory)
  const draggedAgents = draggedIds
    .map(id => agentDefs.get(id))
    .filter((agent): agent is AgentDefinition => Boolean(agent))
  const list = sortedAgents([
    ...categoryAgents.filter(a => !draggedIds.includes(a.id)),
    ...draggedAgents,
  ]).filter(matchesSearch)
  const fromIdx = list.findIndex(a => a.id === draggedId)
  let toIdx = list.findIndex(a => a.id === targetAgentId)
  if (fromIdx === -1 || toIdx === -1) return

  await Promise.all(
    draggedIds
      .filter(id => {
        const agent = agentDefs.get(id)
        return agent && categoryForAgent(agent) !== targetCategory
      })
      .map(id => agentDefs.update(id, { category: targetCategory }))
  )

  // Reorder locally
  const reordered = [...list]
  const [moved] = reordered.splice(fromIdx, 1)
  // Adjust target index after removal
  if (fromIdx < toIdx) toIdx--
  if (dropPosition.value === 'after') toIdx++
  reordered.splice(toIdx, 0, moved)

  // Persist new sortOrder for all affected agents
  for (let i = 0; i < reordered.length; i++) {
    if (reordered[i].sortOrder !== i) {
      await agentDefs.update(reordered[i].id, { sortOrder: i })
    }
  }
}

function onReorderDragEnd() {
  dragReorderId.value = null
  dropTargetId.value = null
}

function isCategoryCollapsed(category: string): boolean {
  return collapsedCategories.value.has(category)
}

function toggleCategory(category: string): void {
  const updated = new Set(collapsedCategories.value)
  if (updated.has(category)) updated.delete(category)
  else updated.add(category)
  collapsedCategories.value = updated
  writeCollapsedCategories(updated)
}

function addCategory() {
  const name = newCategoryName.value.trim()
  if (name) prefs.addAgentCategory(name)
  newCategoryName.value = ''
  showNewCategoryInput.value = false
}

function startRenameCategory(category: string) {
  editingCategory.value = category
  editingCategoryName.value = category
}

function commitRenameCategory(oldName: string) {
  const newName = editingCategoryName.value.trim()
  editingCategory.value = null
  if (newName && newName !== oldName) {
    handleRenameCategory({ oldName, newName })
  }
}

function cancelRenameCategory() {
  editingCategory.value = null
  editingCategoryName.value = ''
}

function onFolderDragOver(e: DragEvent, category: string) {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  folderDropTarget.value = category
}

function onFolderDragLeave(e: DragEvent, category: string) {
  const related = e.relatedTarget as HTMLElement | null
  const current = e.currentTarget as HTMLElement
  if (!related || !current.contains(related)) {
    if (folderDropTarget.value === category) folderDropTarget.value = null
  }
}

async function onFolderDrop(e: DragEvent, category: string) {
  e.preventDefault()
  folderDropTarget.value = null
  await onCategoryDrop(readAgentDropPayload(e, category))
}

function readAgentDropPayload(e: DragEvent, category: string): { itemId?: string; itemIds?: string[]; category: string } {
  const rawIds = e.dataTransfer?.getData(AGENT_IDS_MIME)
  if (rawIds) {
    try {
      const itemIds = JSON.parse(rawIds) as unknown
      if (Array.isArray(itemIds)) {
        return {
          category,
          itemIds: itemIds.filter((id): id is string => typeof id === 'string' && id.length > 0),
        }
      }
    } catch {
      // Fall through to the single-item payload.
    }
  }
  return {
    category,
    itemId: e.dataTransfer?.getData('text/plain') || undefined,
  }
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
}

async function onCategoryDrop(payload: { itemId?: string; itemIds?: string[]; category: string }) {
  const ids = payload.itemIds?.length
    ? payload.itemIds
    : payload.itemId
      ? [payload.itemId]
      : []
  if (!ids.length) return
  await Promise.all(ids.map(id => agentDefs.update(id, { category: payload.category })))
}

function handleRemoveCategory(name: string) {
  prefs.removeAgentCategory(name)
  const known = new Set(knownCategories.value)
  const collapsed = new Set(collapsedCategories.value)
  known.delete(name)
  collapsed.delete(name)
  knownCategories.value = known
  collapsedCategories.value = collapsed
  writeCollapsedCategories(collapsed)
  // Move agents in removed category to uncategorized
  for (const agent of agentDefs.agents) {
    if (agent.category === name) {
      agentDefs.update(agent.id, { category: '' })
    }
  }
}

function handleRenameCategory(payload: { oldName: string; newName: string }) {
  const known = new Set(knownCategories.value)
  const collapsed = new Set(collapsedCategories.value)
  const wasKnown = known.has(payload.oldName)
  const wasCollapsed = collapsed.has(payload.oldName)
  known.delete(payload.oldName)
  collapsed.delete(payload.oldName)
  if (wasKnown) known.add(payload.newName)
  if (wasCollapsed) collapsed.add(payload.newName)
  knownCategories.value = known
  collapsedCategories.value = collapsed
  writeCollapsedCategories(collapsed)

  prefs.renameAgentCategory(payload.oldName, payload.newName)
  // Update agents in the renamed category
  for (const agent of agentDefs.agents) {
    if (agent.category === payload.oldName) {
      agentDefs.update(agent.id, { category: payload.newName })
    }
  }
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
            Create and manage AI agents with custom configurations. Drag and drop the name column to reorder or organize into categories.
          </p>
        </div>
        <button
          class="flex items-center gap-2 px-4 py-2 bg-accent-600 hover:bg-accent-500 text-white rounded-lg text-sm font-medium transition-colors"
          @click="openCreateDialog()"
        >
          <Icon
            icon="lucide:plus"
            class="w-4 h-4"
          />
          New Agent
        </button>
      </div>

      <!-- Search Bar -->
      <div class="flex flex-col gap-3 mb-5 md:flex-row md:items-center">
        <div class="relative flex-1">
          <Icon
            icon="lucide:search"
            class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-theme-500"
          />
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Search agents by name or description…"
            class="w-full pl-10 pr-9 py-2 bg-theme-800/60 border border-theme-700/60 rounded-lg text-sm text-theme-200 placeholder:text-theme-600 focus:outline-none focus:ring-1 focus:ring-accent-500/60 focus:border-accent-500/40 transition-colors"
          >
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
        <form
          v-if="showNewCategoryInput"
          class="flex items-center gap-2"
          @submit.prevent="addCategory"
        >
          <input
            v-model="newCategoryName"
            type="text"
            placeholder="Folder name"
            class="w-full md:w-44 px-3 py-2 bg-theme-800/60 border border-theme-700/60 rounded-lg text-sm text-theme-200 placeholder:text-theme-600 focus:outline-none focus:ring-1 focus:ring-accent-500/60 focus:border-accent-500/40 transition-colors"
            @keydown.esc="showNewCategoryInput = false"
          >
          <button
            class="p-2 rounded-lg bg-accent-600 hover:bg-accent-500 text-white transition-colors"
            title="Add folder"
            type="submit"
          >
            <Icon
              icon="lucide:check"
              class="w-4 h-4"
            />
          </button>
        </form>
        <button
          v-else
          class="inline-flex items-center justify-center gap-2 px-3 py-2 bg-theme-800/70 hover:bg-theme-700 text-theme-300 rounded-lg text-sm font-medium transition-colors"
          @click="showNewCategoryInput = true"
        >
          <Icon
            icon="lucide:folder-plus"
            class="w-4 h-4"
          />
          New Folder
        </button>
      </div>

      <!-- Bulk edit bar -->
      <div
        v-if="isBulkMode"
        class="mb-5 flex flex-col gap-3 rounded-xl border border-accent-500/30 bg-accent-500/8 px-4 py-3 md:flex-row md:items-center md:justify-between"
      >
        <div
          class="text-sm text-theme-200"
        >
          {{ selectedAgentCount }} agent{{ selectedAgentCount === 1 ? '' : 's' }} selected
        </div>
        <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-end md:flex-1">
          <div class="w-full md:w-56">
            <CustomSelect
              :model-value="bulkCategory"
              :groups="categoryGroups"
              placeholder="Set category…"
              size="sm"
              @update:model-value="bulkCategory = $event"
            />
          </div>
          <div class="min-w-0 md:min-w-80">
            <ProviderModelSelect
              :provider-id="bulkProviderId"
              :model-value="bulkModel"
              :providers="providerStore.providers"
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
              :disabled="!hasBulkProviderModelSelection && !bulkCategory"
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

      <!-- Agents explorer -->
      <div
        v-if="hasAnyAgents || prefs.agentCategories.length"
        class="flex flex-col rounded-xl border border-theme-800 overflow-hidden bg-theme-950/45"
      >
        <div class="agent-grid bg-theme-900/70 border-b border-theme-800 px-5 py-3 text-[11px] tracking-wider uppercase text-theme-400">
          <div class="flex items-center" />
          <div>
            Name
          </div>
          <div class="hidden md:block">
            Provider/Model
          </div>
          <div class="hidden lg:block">
            Info
          </div>
          <div class="text-right">
            Actions
          </div>
        </div>

        <div
          v-for="item in uncategorizedAgents"
          :key="item.id"
          class="agent-grid group order-2 border-b border-theme-800/70 cursor-pointer hover:bg-theme-800/30 transition-colors px-5 py-4"
          @click="onRowClick(item.id)"
        >
          <div
            class="flex items-center pt-1"
            @click.stop
          >
            <input
              type="checkbox"
              class="h-4 w-4 rounded border-theme-600 bg-theme-900 text-accent-500 focus:ring-accent-500/60 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
              :class="{ 'opacity-100': isBulkMode || isAgentSelected(item.id) }"
              :checked="isAgentSelected(item.id)"
              @change="toggleAgentSelection(item.id, ($event.target as HTMLInputElement).checked)"
            >
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
              <div class="text-xs text-theme-500 truncate mt-1 md:hidden">
                {{ item.model || 'No model selected' }}
              </div>
            </div>
          </div>
          <div class="hidden md:flex items-center gap-2 md:pt-1">
            <img
              v-if="getProviderLogoUrl(item)"
              :src="getProviderLogoUrl(item) || ''"
              :alt="getProviderName(item)"
              class="w-5 h-5 rounded object-contain shrink-0"
            >
            <div class="flex flex-col gap-0.5 min-w-0">
              <div class="text-sm text-theme-200 font-medium">
                {{ getProviderName(item) }}
              </div>
              <div class="text-xs text-theme-500 truncate">
                {{ item.model }}
              </div>
            </div>
          </div>
          <div class="hidden lg:flex items-center gap-3 text-xs text-theme-500">
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
              v-if="item.subAgents?.length"
              :disabled="item.subAgents.length === 0"
              placement="mouse"
              :max-width="220"
            >
              <span class="flex items-center gap-1 bg-theme-700/50 px-1.5 py-0.5 rounded cursor-default">
                <Icon
                  icon="lucide:users"
                  class="w-3 h-3"
                />
                {{ item.subAgents.length }}
              </span>
              <template #content>
                <div class="font-medium text-theme-300 mb-1.5">
                  {{ item.subAgents.length }} sub-{{ item.subAgents.length === 1 ? 'agent' : 'agents' }}
                </div>
                <div
                  v-for="sa in item.subAgents.slice(0, TOOLTIP_MAX_TOOLS)"
                  :key="sa.agentId"
                  class="font-mono text-[10px] text-theme-300 truncate py-0.5"
                >
                  {{ agentDefs.get(sa.agentId)?.name ?? sa.agentId }}
                </div>
                <div
                  v-if="item.subAgents.length > TOOLTIP_MAX_TOOLS"
                  class="text-theme-500 text-[10px] mt-1"
                >
                  +{{ item.subAgents.length - TOOLTIP_MAX_TOOLS }} more
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
          v-if="hasUncategorized && uncategorizedAgents.length === 0 && !searchQuery"
          class="order-2 border-b border-theme-800/70 px-5 py-4 text-sm text-theme-500"
        >
          Uncategorized agents are hidden by the current filters.
        </div>

        <div
          v-for="folder in categoryFolders"
          :key="folder.category"
          class="order-1 border-b border-theme-800/70"
        >
          <div
            class="group flex items-center gap-3 px-5 py-3 bg-theme-900/35 hover:bg-theme-800/35 transition-colors"
            :class="{ 'ring-1 ring-accent-500/60 ring-inset bg-accent-500/10': folderDropTarget === folder.category }"
            @dragover="onFolderDragOver($event, folder.category)"
            @dragleave="onFolderDragLeave($event, folder.category)"
            @drop="onFolderDrop($event, folder.category)"
          >
            <div
              class="flex w-4 items-center"
              @click.stop
            >
              <input
                v-if="folder.agents.length"
                type="checkbox"
                class="h-4 w-4 rounded border-theme-600 bg-theme-900 text-accent-500 focus:ring-accent-500/60 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                :class="{ 'opacity-100': isBulkMode || areAllAgentsSelected(folder.agents) }"
                :checked="areAllAgentsSelected(folder.agents)"
                @change="toggleAgentGroupSelection(folder.agents, ($event.target as HTMLInputElement).checked)"
              >
            </div>
            <button
              class="p-1 -ml-1 text-theme-500 hover:text-theme-200 transition-colors"
              :aria-expanded="!isCategoryCollapsed(folder.category)"
              @click="toggleCategory(folder.category)"
            >
              <Icon
                icon="lucide:chevron-down"
                class="w-4 h-4 transition-transform"
                :class="{ '-rotate-90': isCategoryCollapsed(folder.category) }"
              />
            </button>
            <Icon
              :icon="isCategoryCollapsed(folder.category) ? 'lucide:folder' : 'lucide:folder-open'"
              class="w-5 h-5 text-amber-400"
            />
            <form
              v-if="editingCategory === folder.category"
              class="flex min-w-0 flex-1 items-center gap-2"
              @submit.prevent="commitRenameCategory(folder.category)"
            >
              <input
                v-model="editingCategoryName"
                class="min-w-0 flex-1 px-2 py-1 bg-theme-800 border border-theme-700 rounded-md text-sm text-theme-100 focus:outline-none focus:ring-1 focus:ring-accent-500"
                @keydown.esc="cancelRenameCategory"
              >
              <button
                class="p-1.5 rounded-md text-theme-400 hover:text-accent-300 transition-colors"
                type="submit"
                title="Save folder name"
              >
                <Icon
                  icon="lucide:check"
                  class="w-4 h-4"
                />
              </button>
            </form>
            <button
              v-else
              class="min-w-0 flex-1 text-left"
              @click="toggleCategory(folder.category)"
            >
              <span class="text-sm font-medium text-theme-100 truncate">{{ folder.category }}</span>
              <span class="ml-2 text-xs text-theme-500">{{ folder.agents.length }}</span>
            </button>
            <button
              class="p-1.5 text-theme-500 hover:text-accent-400 rounded-md transition-all"
              title="New agent in folder"
              @click.stop="openCreateDialog(folder.category)"
            >
              <Icon
                icon="lucide:plus"
                class="w-4 h-4"
              />
            </button>
            <button
              class="p-1.5 text-theme-500 hover:text-theme-200 rounded-md transition-all"
              title="Rename folder"
              @click.stop="startRenameCategory(folder.category)"
            >
              <Icon
                icon="lucide:pencil"
                class="w-4 h-4"
              />
            </button>
            <button
              class="p-1.5 text-theme-500 hover:text-red-400 rounded-md transition-all"
              title="Delete folder"
              @click.stop="handleRemoveCategory(folder.category)"
            >
              <Icon
                icon="lucide:trash-2"
                class="w-4 h-4"
              />
            </button>
          </div>

          <div v-if="!isCategoryCollapsed(folder.category)">
            <div
              v-if="folder.agents.length === 0"
              class="px-14 py-4 text-sm text-theme-500"
            >
              {{ searchQuery ? 'No matching agents in this folder.' : 'Drop agents here or create one in this folder.' }}
            </div>
            <div
              v-for="item in folder.agents"
              :key="item.id"
              class="agent-grid folder-agent-row group border-t border-theme-800/70 cursor-pointer hover:bg-theme-800/30 transition-colors px-5 py-4"
              @click="onRowClick(item.id)"
            >
              <div
                class="flex items-center pt-1"
                @click.stop
              >
                <input
                  type="checkbox"
                  class="h-4 w-4 rounded border-theme-600 bg-theme-900 text-accent-500 focus:ring-accent-500/60 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                  :class="{ 'opacity-100': isBulkMode || isAgentSelected(item.id) }"
                  :checked="isAgentSelected(item.id)"
                  @change="toggleAgentSelection(item.id, ($event.target as HTMLInputElement).checked)"
                >
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
                  <div class="text-xs text-theme-500 truncate mt-1 md:hidden">
                    {{ item.model || 'No model selected' }}
                  </div>
                </div>
              </div>
              <div class="hidden md:flex items-center gap-2 md:pt-1">
                <img
                  v-if="getProviderLogoUrl(item)"
                  :src="getProviderLogoUrl(item) || ''"
                  :alt="getProviderName(item)"
                  class="w-5 h-5 rounded object-contain shrink-0"
                >
                <div class="flex flex-col gap-0.5 min-w-0">
                  <div class="text-sm text-theme-200 font-medium">
                    {{ getProviderName(item) }}
                  </div>
                  <div class="text-xs text-theme-500 truncate">
                    {{ item.model }}
                  </div>
                </div>
              </div>
              <div class="hidden lg:flex items-center gap-3 text-xs text-theme-500">
                <span class="flex items-center gap-1 bg-theme-700/50 px-1.5 py-0.5 rounded">
                  <Icon
                    icon="lucide:wrench"
                    class="w-3 h-3"
                  />
                  {{ item.tools.length }}
                </span>
                <span
                  v-if="item.subAgents?.length"
                  class="flex items-center gap-1 bg-theme-700/50 px-1.5 py-0.5 rounded"
                >
                  <Icon
                    icon="lucide:users"
                    class="w-3 h-3"
                  />
                  {{ item.subAgents.length }}
                </span>
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
          </div>
        </div>
      </div>

      <!-- Empty State -->
      <BaseCard
        v-if="!visibleAgentCount && (!prefs.agentCategories.length || searchQuery)"
        class="p-12 text-center"
      >
        <div
          class="w-16 h-16 rounded-2xl bg-accent-500/10 flex items-center justify-center mx-auto mb-4"
        >
          <Icon
            icon="lucide:bot"
            class="w-8 h-8 text-accent-400"
          />
        </div>
        <h3 class="text-lg font-medium text-theme-200 mb-2">
          {{ searchQuery ? 'No Matching Agents' : 'No Agents Yet' }}
        </h3>
        <p class="text-sm text-theme-500 max-w-md mx-auto mb-6">
          {{ searchQuery
            ? 'No agents match your search. Try a different term or clear the search.'
            : 'Create your first agent to get started. Each agent can be configured with its own model, tools, and memory.'
          }}
        </p>
        <button
          class="inline-flex items-center gap-2 px-4 py-2 bg-accent-600 hover:bg-accent-500 text-white rounded-lg text-sm font-medium transition-colors"
          @click="openCreateDialog()"
        >
          <Icon
            icon="lucide:plus"
            class="w-4 h-4"
          />
          Create Agent
        </button>
      </BaseCard>

      <!-- Create Dialog -->
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

      <!-- Delete Confirmation Modal -->
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
  grid-template-columns: 40px minmax(180px, 1.5fr) minmax(180px, 1fr) 200px 96px;
  gap: 1rem;
  align-items: start;
}

.folder-agent-row {
  padding-left: 4rem;
}

@media (max-width: 1023px) {
  .agent-grid {
    grid-template-columns: 40px minmax(180px, 1fr) minmax(140px, auto);
  }
}

@media (max-width: 767px) {
  .agent-grid {
    grid-template-columns: 32px minmax(0, 1fr) auto;
    gap: 0.75rem;
  }

  .folder-agent-row {
    padding-left: 2.5rem;
  }
}
</style>
