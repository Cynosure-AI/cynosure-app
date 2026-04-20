<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { useAgentStore } from '../stores/agent-runtime.store'
import { useProviderStore } from '../stores/provider.store'
import { usePreferencesStore } from '../stores/preferences.store'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import ModalDialog from '../components/shared/ModalDialog.vue'
import CategoryTabBar from '../components/shared/CategoryTabBar.vue'
import { SK_AGENTS_VIEW_MODE } from '../utils/storage-keys'

const agentDefs = useAgentDefinitionsStore()
const agentStore = useAgentStore()
const providerStore = useProviderStore()
const prefs = usePreferencesStore()
const router = useRouter()

// View mode toggle (grid / list) — persisted in localStorage
type ViewMode = 'grid' | 'list'
const viewMode = ref<ViewMode>((localStorage.getItem(SK_AGENTS_VIEW_MODE) as ViewMode) || 'grid')
function setViewMode(mode: ViewMode) {
  viewMode.value = mode
  localStorage.setItem(SK_AGENTS_VIEW_MODE, mode)
}

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

const hasUncategorized = computed(() =>
  agentDefs.agents.some(a => !a.category)
)

const filteredAgents = computed(() => {
  let agents = agentDefs.agents
  if (activeCategory.value === '__uncategorized__') agents = agents.filter(a => !a.category)
  else if (activeCategory.value) agents = agents.filter(a => (a.category || '') === activeCategory.value)
  const q = searchQuery.value.trim().toLowerCase()
  if (q) agents = agents.filter(a => a.name.toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q))
  return [...agents].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
})

const agentsWithIssues = computed(() => {
  const availableKeys = new Set(agentStore.availableTools.map(t => `${t.namespace.id}::${t.name}`))
  const allAgentIds = new Set(agentDefs.agents.map(a => a.id))
  const isToolMissing = (t: string) => !t.includes('::') || !availableKeys.has(t)
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

  // Determine drop position based on cursor position within the element
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const isListView = viewMode.value === 'list'
  const midpoint = isListView
    ? rect.top + rect.height / 2
    : rect.left + rect.width / 2
  const pos = isListView ? e.clientY : e.clientX
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

async function onCategoryDrop(payload: { itemId: string; category: string }) {
  await agentDefs.update(payload.itemId, { category: payload.category })
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
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-5xl mx-auto py-8 px-6">
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
      />

      <!-- Search Bar + View Toggle -->
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

        <!-- View mode toggle -->
        <div class="flex bg-zinc-800 border border-zinc-700/60 rounded-lg p-0.5 shrink-0">
          <button
            class="px-2 py-1.5 rounded-md transition-colors"
            :class="viewMode === 'grid' ? 'bg-zinc-600 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'"
            title="Grid view"
            @click="setViewMode('grid')"
          >
            <Icon
              icon="lucide:layout-grid"
              class="w-4 h-4"
            />
          </button>
          <button
            class="px-2 py-1.5 rounded-md transition-colors"
            :class="viewMode === 'list' ? 'bg-zinc-600 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'"
            title="List view"
            @click="setViewMode('list')"
          >
            <Icon
              icon="lucide:list"
              class="w-4 h-4"
            />
          </button>
        </div>
      </div>

      <!-- Agents Grid -->
      <div
        v-if="filteredAgents.length && viewMode === 'grid'"
        class="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4"
      >
        <div
          v-for="agent in filteredAgents"
          :key="agent.id"
          draggable="true"
          class="group relative rounded-xl border bg-zinc-800/60 p-5 hover:border-zinc-600 transition-all cursor-pointer"
          :class="[
            dragReorderId === agent.id ? 'border-blue-500/60 opacity-50' : 'border-zinc-700',
            dropTargetId === agent.id && dropPosition === 'before' ? 'ring-l-2 ring-blue-500' : '',
            dropTargetId === agent.id && dropPosition === 'after' ? 'ring-r-2 ring-blue-500' : ''
          ]"
          @click="router.push(`/agents/${agent.id}`)"
          @dragstart="onReorderDragStart($event, agent.id)"
          @dragover="onReorderDragOver($event, agent.id)"
          @dragleave="onReorderDragLeave($event, agent.id)"
          @drop="onReorderDrop($event, agent.id)"
          @dragend="onReorderDragEnd"
        >
          <!-- Drop indicator: left edge -->
          <div
            v-if="dropTargetId === agent.id && dropPosition === 'before'"
            class="absolute -left-0.75 top-1 bottom-1 w-0.75 rounded-full bg-blue-500"
          />
          <!-- Drop indicator: right edge -->
          <div
            v-if="dropTargetId === agent.id && dropPosition === 'after'"
            class="absolute -right-0.75 top-1 bottom-1 w-0.75 rounded-full bg-blue-500"
          />
          <div class="flex items-start justify-between mb-3">
            <div
              class="w-10 h-10 rounded-lg bg-linear-to-br from-blue-500/20 to-purple-500/20 flex items-center justify-center overflow-hidden"
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
                class="w-5 h-5 text-blue-400"
              />
            </div>
            <div class="flex items-center gap-0.5">
              <button
                class="opacity-0 group-hover:opacity-100 p-1.5 text-zinc-500 hover:text-blue-400 rounded-md transition-all"
                title="Duplicate agent"
                @click.stop="duplicateAgent(agent.id)"
              >
                <Icon
                  icon="lucide:copy"
                  class="w-4 h-4"
                />
              </button>
              <button
                class="opacity-0 group-hover:opacity-100 p-1.5 text-zinc-500 hover:text-red-400 rounded-md transition-all"
                @click.stop="confirmDelete(agent)"
              >
                <Icon
                  icon="lucide:trash-2"
                  class="w-4 h-4"
                />
              </button>
            </div>
          </div>
          <h3 class="text-sm font-medium text-zinc-100 mb-1">
            {{ agent.name }}
            <Icon
              v-if="agentsWithIssues.has(agent.id)"
              icon="lucide:alert-triangle"
              class="w-3.5 h-3.5 text-amber-400 inline-block ml-1"
            />
          </h3>
          <p
            v-if="agent.description"
            class="text-xs text-zinc-500 mb-3 line-clamp-2"
          >
            {{ agent.description }}
          </p>
          <div class="flex items-center gap-3 text-xs text-zinc-600 flex-wrap">
            <span
              v-if="agent.model"
              class="flex items-center gap-1"
            >
              <Icon
                icon="lucide:cpu"
                class="w-3 h-3"
              />
              {{ agent.model }}
            </span>
            <span class="flex items-center gap-1">
              <Icon
                icon="lucide:wrench"
                class="w-3 h-3"
              />
              {{ agent.tools.length }} tools
            </span>
            <span
              v-if="agent.subAgents?.length"
              class="flex items-center gap-1"
            >
              <Icon
                icon="lucide:users"
                class="w-3 h-3"
              />
              {{ agent.subAgents.length }} sub-agent{{ agent.subAgents.length === 1 ? '' : 's' }}
            </span>
            <span class="flex items-center gap-1">
              <Icon
                icon="lucide:calendar"
                class="w-3 h-3"
              />
              {{ formatDate(agent.createdAt) }}
            </span>
          </div>
        </div>
      </div>

      <!-- Agents List -->
      <div
        v-if="filteredAgents.length && viewMode === 'list'"
        class="flex flex-col gap-2"
      >
        <div
          v-for="agent in filteredAgents"
          :key="agent.id"
          draggable="true"
          class="group relative flex items-center gap-4 rounded-xl border bg-zinc-800/60 px-4 py-3 hover:border-zinc-600 transition-all cursor-pointer"
          :class="dragReorderId === agent.id ? 'border-blue-500/60 opacity-50' : 'border-zinc-700'"
          @click="router.push(`/agents/${agent.id}`)"
          @dragstart="onReorderDragStart($event, agent.id)"
          @dragover="onReorderDragOver($event, agent.id)"
          @dragleave="onReorderDragLeave($event, agent.id)"
          @drop="onReorderDrop($event, agent.id)"
          @dragend="onReorderDragEnd"
        >
          <!-- Drop indicator: top edge -->
          <div
            v-if="dropTargetId === agent.id && dropPosition === 'before'"
            class="absolute -top-0.75 left-2 right-2 h-0.75 rounded-full bg-blue-500"
          />
          <!-- Drop indicator: bottom edge -->
          <div
            v-if="dropTargetId === agent.id && dropPosition === 'after'"
            class="absolute -bottom-0.75 left-2 right-2 h-0.75 rounded-full bg-blue-500"
          />

          <!-- Icon -->
          <div class="w-9 h-9 shrink-0 rounded-lg bg-linear-to-br from-blue-500/20 to-purple-500/20 flex items-center justify-center overflow-hidden">
            <img
              v-if="agent.iconUrl"
              :src="agent.iconUrl"
              alt=""
              class="w-full h-full object-cover"
            >
            <Icon
              v-else
              icon="lucide:bot"
              class="w-4 h-4 text-blue-400"
            />
          </div>

          <!-- Name + description -->
          <div class="flex-1 min-w-0">
            <h3 class="text-sm font-medium text-zinc-100 truncate">
              {{ agent.name }}
              <Icon
                v-if="agentsWithIssues.has(agent.id)"
                icon="lucide:alert-triangle"
                class="w-3.5 h-3.5 text-amber-400 inline-block ml-1"
              />
            </h3>
            <p
              v-if="agent.description"
              class="text-xs text-zinc-500 truncate"
            >
              {{ agent.description }}
            </p>
          </div>

          <!-- Meta -->
          <div class="hidden sm:flex items-center gap-3 text-xs text-zinc-600 shrink-0">
            <span
              v-if="agent.model"
              class="flex items-center gap-1"
            >
              <Icon
                icon="lucide:cpu"
                class="w-3 h-3"
              />
              {{ agent.model }}
            </span>
            <span class="flex items-center gap-1">
              <Icon
                icon="lucide:wrench"
                class="w-3 h-3"
              />
              {{ agent.tools.length }}
            </span>
            <span
              v-if="agent.subAgents?.length"
              class="flex items-center gap-1"
            >
              <Icon
                icon="lucide:users"
                class="w-3 h-3"
              />
              {{ agent.subAgents.length }}
            </span>
            <span class="flex items-center gap-1">
              <Icon
                icon="lucide:calendar"
                class="w-3 h-3"
              />
              {{ formatDate(agent.createdAt) }}
            </span>
          </div>

          <!-- Actions -->
          <div class="flex items-center gap-0.5 shrink-0">
            <button
              class="opacity-0 group-hover:opacity-100 p-1.5 text-zinc-500 hover:text-blue-400 rounded-md transition-all"
              title="Duplicate agent"
              @click.stop="duplicateAgent(agent.id)"
            >
              <Icon
                icon="lucide:copy"
                class="w-4 h-4"
              />
            </button>
            <button
              class="opacity-0 group-hover:opacity-100 p-1.5 text-zinc-500 hover:text-red-400 rounded-md transition-all"
              @click.stop="confirmDelete(agent)"
            >
              <Icon
                icon="lucide:trash-2"
                class="w-4 h-4"
              />
            </button>
          </div>
        </div>
      </div>

      <!-- Empty State -->
      <div
        v-if="!filteredAgents.length"
        class="rounded-xl border border-zinc-700 bg-zinc-800 p-12 text-center"
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
      </div>

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
