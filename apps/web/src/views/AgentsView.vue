<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { useAgentStore } from '../stores/agent-runtime.store'
import { useProviderStore } from '../stores/provider.store'
import { usePreferencesStore } from '../stores/preferences.store'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import BaseCard from '../components/shared/BaseCard.vue'
import DataTable from '../components/shared/DataTable.vue'
import ModalDialog from '../components/shared/ModalDialog.vue'
import CategoryTabBar from '../components/shared/CategoryTabBar.vue'
import ProviderModelSelect from '../components/shared/ProviderModelSelect.vue'
import { useProviderLogos } from '../composables/useProviderLogos'
import type { Column } from '../components/shared/DataTable.vue'
import type { AgentDefinition } from '../api/types'

const agentDefs = useAgentDefinitionsStore()
const agentStore = useAgentStore()
const providerStore = useProviderStore()
const prefs = usePreferencesStore()
const router = useRouter()
const { logoUrl } = useProviderLogos()
const AGENT_IDS_MIME = 'application/x-cynosure-agent-ids'

const showCreateDialog = ref(false)
const newName = ref('')
const newDescription = ref('')

// Delete confirmation
const showDeleteConfirm = ref(false)
const pendingDeleteId = ref<string | null>(null)
const pendingDeleteName = ref('')

// Category filter
const activeCategory = ref('')
const searchQuery = ref('')
const bulkSelectionIds = ref<string[]>([])
const bulkProviderId = ref('')
const bulkModel = ref('')
const hasBulkProviderModelSelection = ref(false)

const hasUncategorized = computed(() =>
  agentDefs.agents.some(a => !a.category || !prefs.agentCategories.includes(a.category))
)

const filteredAgents = computed(() => {
  let agents = agentDefs.agents
  if (activeCategory.value === '__uncategorized__') agents = agents.filter(a => !a.category || !prefs.agentCategories.includes(a.category))
  else if (activeCategory.value) agents = agents.filter(a => (a.category || '') === activeCategory.value)
  const q = searchQuery.value.trim().toLowerCase()
  if (q) agents = agents.filter(a => a.name.toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q))
  return [...agents].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
})

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

// Table columns for DataTable component
const agentTableColumns: Column[] = [
  { key: 'name', label: 'Name', width: 'minmax(0,1.5fr)' },
  { key: 'provider', label: 'Provider/Model', width: 'minmax(200px,1fr)', hideOnMobile: true },
  { key: 'metadata', label: 'Info', width: '200px', hideOnMobile: true },
  { key: 'actions', label: 'Actions', width: '120px' },
]

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

function onSelectionInputChange(agentId: string, event: Event): void {
  const target = event.target as HTMLInputElement | null
  toggleAgentSelection(agentId, target?.checked ?? false)
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

async function applyBulkProviderModel(): Promise<void> {
  if (!isBulkMode.value || !hasBulkProviderModelSelection.value) return
  const ids = [...bulkSelectionIds.value]
  await Promise.all(ids.map(id => agentDefs.update(id, {
    providerId: bulkProviderId.value,
    model: bulkModel.value,
  })))
  clearBulkSelection()
}

onMounted(() => agentDefs.load())

async function createAgent() {
  if (!newName.value.trim()) return
  const agent = await agentDefs.create({
    name: newName.value.trim(),
    codename: '',
    description: newDescription.value.trim(),
    category: activeCategory.value || '',
    iconUrl: null,
    providerId: providerStore.lastUsedProviderId || '',
    model: providerStore.lastUsedProvider?.defaultModel || '',
    systemPrompt: '',
    cronPrompt: '',
    tools: [],
    autoApproveTools: false,
    overrideSubAgents: false,
    autoToolRouting: false,
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

  const list = filteredAgents.value
  const fromIdx = list.findIndex(a => a.id === draggedId)
  let toIdx = list.findIndex(a => a.id === targetAgentId)
  if (fromIdx === -1 || toIdx === -1) return

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
  // Move agents in removed category to uncategorized
  for (const agent of agentDefs.agents) {
    if (agent.category === name) {
      agentDefs.update(agent.id, { category: '' })
    }
  }
  if (activeCategory.value === name) activeCategory.value = ''
}

function handleRenameCategory(payload: { oldName: string; newName: string }) {
  prefs.renameAgentCategory(payload.oldName, payload.newName)
  // Update agents in the renamed category
  for (const agent of agentDefs.agents) {
    if (agent.category === payload.oldName) {
      agentDefs.update(agent.id, { category: payload.newName })
    }
  }
  if (activeCategory.value === payload.oldName) activeCategory.value = payload.newName
}

function handleReorderCategory(payload: { from: string; to: string; before: boolean }) {
  prefs.reorderAgentCategory(payload.from, payload.to, payload.before)
}
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-6xl mx-auto py-8 px-6">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold text-zinc-100">
            My Agents
          </h1>
          <p class="text-sm text-zinc-500 mt-1">
            Create and manage AI agents with custom configurations. Drag and drop to reorder or organize into categories.
          </p>
        </div>
        <button
          class="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors"
          @click="showCreateDialog = true"
        >
          <Icon
            icon="lucide:plus"
            class="w-4 h-4"
          />
          New Agent
        </button>
      </div>

      <!-- Category Tabs -->
      <CategoryTabBar
        v-model="activeCategory"
        :categories="prefs.agentCategories"
        :show-uncategorized="hasUncategorized"
        class="mb-5"
        @add="prefs.addAgentCategory"
        @remove="handleRemoveCategory"
        @rename="handleRenameCategory"
        @drop="onCategoryDrop"
        @reorder="handleReorderCategory"
      />

      <!-- Search Bar -->
      <div class="flex items-center gap-2 mb-5">
        <div class="relative flex-1">
          <Icon
            icon="lucide:search"
            class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500"
          />
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Search agents by name or description…"
            class="w-full pl-10 pr-9 py-2 bg-zinc-800/60 border border-zinc-700/60 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500/60 focus:border-blue-500/40 transition-colors"
          >
          <button
            v-if="searchQuery"
            class="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-zinc-500 hover:text-zinc-300 transition-colors"
            @click="searchQuery = ''"
          >
            <Icon
              icon="lucide:x"
              class="w-4 h-4"
            />
          </button>
        </div>
      </div>

      <!-- Bulk edit bar -->
      <div
        v-if="isBulkMode"
        class="mb-5 flex flex-col gap-3 rounded-xl border border-blue-500/30 bg-blue-500/8 px-4 py-3 md:flex-row md:items-center md:justify-between"
      >
        <div
          class="text-sm text-zinc-200"
        >
          {{ selectedAgentCount }} agent{{ selectedAgentCount === 1 ? '' : 's' }} selected
        </div>
        <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-end md:flex-1">
          <div class="min-w-0 md:min-w-80">
            <ProviderModelSelect
              :provider-id="bulkProviderId"
              :model-value="bulkModel"
              :providers="providerStore.providers"
              placeholder="Set provider/model for selected agents"
              dropdown-width="w-[28rem]"
              @update:provider-id="bulkProviderId = $event"
              @update:model-value="bulkModel = $event"
              @change="hasBulkProviderModelSelection = Boolean($event.providerId)"
            />
          </div>
          <div class="flex items-center gap-2">
            <button
              class="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
              :disabled="!hasBulkProviderModelSelection"
              @click="applyBulkProviderModel"
            >
              Apply
            </button>
            <button
              class="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors"
              @click="clearBulkSelection"
            >
              Clear
            </button>
          </div>
        </div>
      </div>

      <!-- Agents List using DataTable -->
      <DataTable
        v-if="filteredAgents.length"
        :items="filteredAgents"
        :columns="agentTableColumns"
        :selectable="true"
        :selection-column="{ hideOnMobile: true }"
        :selected-ids="bulkSelectionIds"
        @update:selected-ids="bulkSelectionIds = $event"
        @row-click="onRowClick($event.id)"
      >
        <!-- Name column with icon and description -->
        <template #col-name="{ item }">
          <div class="flex items-start gap-3 min-w-0">
            <div class="w-9 h-9 shrink-0 rounded-lg bg-linear-to-br from-blue-500/20 to-purple-500/20 flex items-center justify-center overflow-hidden">
              <img
                v-if="item.iconUrl"
                :src="item.iconUrl"
                alt=""
                class="w-full h-full object-cover"
              >
              <Icon
                v-else
                icon="lucide:bot"
                class="w-4 h-4 text-blue-400"
              />
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium text-zinc-100 truncate flex items-center gap-1">
                {{ item.name }}
                <Icon
                  v-if="agentsWithIssues.has(item.id)"
                  icon="lucide:alert-triangle"
                  class="w-3.5 h-3.5 text-amber-400 shrink-0"
                />
              </div>
              <div
                v-if="item.description"
                class="text-xs text-zinc-500 truncate"
              >
                {{ item.description }}
              </div>
              <div class="text-xs text-zinc-500 truncate mt-1 md:hidden">
                {{ item.model || 'No model selected' }}
              </div>
            </div>
          </div>
        </template>

        <!-- Provider/Model column -->
        <template #col-provider="{ item }">
          <div class="flex items-center gap-2 md:pt-1">
            <img
              v-if="getProviderLogoUrl(item)"
              :src="getProviderLogoUrl(item) || ''"
              :alt="getProviderName(item)"
              class="w-5 h-5 rounded object-contain shrink-0"
            >
            <div class="flex flex-col gap-0.5 min-w-0">
              <div class="text-sm text-zinc-200 font-medium">
                {{ getProviderName(item) }}
              </div>
              <div class="text-xs text-zinc-500 truncate">
                {{ item.model }}
              </div>
            </div>
          </div>
        </template>

        <!-- Metadata column (tools, subagents, created date) -->
        <template #col-metadata="{ item }">
          <div class="flex items-center gap-3 text-xs text-zinc-600">
            <span class="flex items-center gap-1">
              <Icon
                icon="lucide:wrench"
                class="w-3 h-3"
              />
              {{ item.tools.length }}
            </span>
            <span
              v-if="item.subAgents?.length"
              class="flex items-center gap-1"
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
        </template>

        <!-- Actions column -->
        <template #col-actions="{ item }">
          <div class="flex items-center gap-1">
            <button
              class="p-1.5 text-zinc-500 hover:text-blue-400 rounded-md transition-all"
              title="Duplicate agent"
              @click.stop="duplicateAgent(item.id)"
            >
              <Icon
                icon="lucide:copy"
                class="w-4 h-4"
              />
            </button>
            <button
              class="p-1.5 text-zinc-500 hover:text-red-400 rounded-md transition-all"
              title="Delete agent"
              @click.stop="confirmDelete(item)"
            >
              <Icon
                icon="lucide:trash-2"
                class="w-4 h-4"
              />
            </button>
          </div>
        </template>
      </DataTable>

      <!-- Empty State -->
      <BaseCard
        v-if="!filteredAgents.length"
        class="p-12 text-center"
      >
        <div
          class="w-16 h-16 rounded-2xl bg-blue-500/10 flex items-center justify-center mx-auto mb-4"
        >
          <Icon
            icon="lucide:bot"
            class="w-8 h-8 text-blue-400"
          />
        </div>
        <h3 class="text-lg font-medium text-zinc-200 mb-2">
          {{ searchQuery ? 'No Matching Agents' : activeCategory ? 'No Agents in This Category' : 'No Agents Yet' }}
        </h3>
        <p class="text-sm text-zinc-500 max-w-md mx-auto mb-6">
          {{ searchQuery
            ? 'No agents match your search. Try a different term or clear the search.'
            : activeCategory
              ? 'Drag and drop agent cards onto this tab to categorize them, or create a new agent.'
              : 'Create your first agent to get started. Each agent can be configured with its own model, tools, and memory.'
          }}
        </p>
        <button
          class="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors"
          @click="showCreateDialog = true"
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
          <div class="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-md shadow-2xl">
            <h2 class="text-lg font-semibold text-zinc-100 mb-4">
              Create New Agent
            </h2>
            <div class="space-y-4">
              <div>
                <label class="block text-sm text-zinc-400 mb-1.5">Name</label>
                <input
                  v-model="newName"
                  type="text"
                  placeholder="My Agent"
                  class="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  @keydown.enter="createAgent"
                >
              </div>
              <div>
                <label class="block text-sm text-zinc-400 mb-1.5">Description</label>
                <textarea
                  v-model="newDescription"
                  placeholder="What does this agent do?"
                  class="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none h-20"
                />
              </div>
            </div>
            <div class="flex justify-end gap-2 mt-6">
              <button
                class="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
                @click="showCreateDialog = false"
              >
                Cancel
              </button>
              <button
                class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
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
        <p class="text-zinc-400 leading-relaxed">
          Are you sure you want to delete <strong class="text-zinc-200">{{ pendingDeleteName }}</strong>? This action cannot be undone.
        </p>
        <template #actions>
          <button
            class="w-full px-4 py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl text-center font-medium transition-colors"
            @click="deleteAgent(pendingDeleteId!)"
          >
            Delete Agent
          </button>
          <button
            class="w-full px-4 py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl text-center font-medium transition-colors"
            @click="showDeleteConfirm = false"
          >
            Cancel
          </button>
        </template>
      </ModalDialog>
    </div>
  </div>
</template>
