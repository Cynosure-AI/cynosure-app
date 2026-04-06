<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { api, type AgentDefinition, type FileWatcher } from '../../api/client'
import { useProviderStore } from '../../stores/provider.store'
import { Icon } from '@iconify/vue'
import TabBar, { type TabDef } from '../../components/shared/TabBar.vue'
import ModalDialog from '../../components/shared/ModalDialog.vue'
import CustomSelect, { type SelectOptionGroup } from '../../components/shared/CustomSelect.vue'
import ToggleSwitch from '../../components/shared/ToggleSwitch.vue'
import { useProviderLogos } from '../../composables/useProviderLogos'

const { logoUrl } = useProviderLogos()

const watchers = ref<FileWatcher[]>([])
const allAgents = ref<AgentDefinition[]>([])
const loading = ref(true)
const activeTab = ref<'file-watchers'>('file-watchers')
let pollTimer: ReturnType<typeof setInterval> | undefined

const providerStore = useProviderStore()

// Dialog state
const showDialog = ref(false)
const editingId = ref<string | null>(null)
const dlgName = ref('')
const dlgAgentId = ref('')
const dlgPaths = ref('')
const dlgIgnorePatterns = ref('node_modules/**\n.git/**')
const dlgPrompt = ref('')
const dlgDebounceMs = ref(5)
const dlgModelOverride = ref('')
const dlgProviderOverride = ref('')
const dlgModels = ref<string[]>([])
const loadingModels = ref(false)
const saving = ref(false)

// Delete confirm
const showDeleteConfirm = ref(false)
const pendingDeleteId = ref<string | null>(null)
const pendingDeleteName = ref('')

function resetDlg() {
  editingId.value = null
  dlgName.value = ''
  dlgAgentId.value = ''
  dlgPaths.value = ''
  dlgIgnorePatterns.value = 'node_modules/**\n.git/**'
  dlgPrompt.value = ''
  dlgDebounceMs.value = 5
  dlgModelOverride.value = ''
  dlgProviderOverride.value = ''
  dlgModels.value = []
}

async function openAddDialog() {
  allAgents.value = await api.agents.list()
  resetDlg()
  showDialog.value = true
}

async function openEditDialog(w: FileWatcher) {
  allAgents.value = await api.agents.list()
  resetDlg()
  editingId.value = w.id
  dlgName.value = w.name || ''
  dlgAgentId.value = w.agentId
  dlgPaths.value = w.paths.join('\n')
  dlgIgnorePatterns.value = w.ignorePatterns.join('\n')
  dlgPrompt.value = w.prompt || ''
  dlgDebounceMs.value = Math.round(w.debounceMs / 1000)
  dlgModelOverride.value = w.modelOverride || ''
  dlgProviderOverride.value = w.providerOverride || ''
  showDialog.value = true
}

async function save() {
  const paths = dlgPaths.value.split('\n').map(p => p.trim()).filter(Boolean)
  if (!paths.length) return

  saving.value = true
  try {
    const ignorePatterns = dlgIgnorePatterns.value.split('\n').map(p => p.trim()).filter(Boolean)
    const debounceMs = Math.max(1000, dlgDebounceMs.value * 1000)

    if (editingId.value) {
      await api.fileWatchers.update(editingId.value, {
        name: dlgName.value.trim(),
        paths,
        ignorePatterns,
        prompt: dlgPrompt.value,
        debounceMs,
        modelOverride: dlgModelOverride.value,
        providerOverride: dlgProviderOverride.value,
      })
    } else {
      if (!dlgAgentId.value) return
      await api.fileWatchers.create({
        name: dlgName.value.trim(),
        agentId: dlgAgentId.value,
        paths,
        ignorePatterns,
        prompt: dlgPrompt.value,
        debounceMs,
        enabled: true,
        modelOverride: dlgModelOverride.value,
        providerOverride: dlgProviderOverride.value,
      })
    }
    showDialog.value = false
    await loadWatchers()
  } finally {
    saving.value = false
  }
}

async function toggleWatcher(id: string, enabled: boolean) {
  await api.fileWatchers.update(id, { enabled })
  await loadWatchers()
}

function confirmDelete(w: FileWatcher) {
  pendingDeleteId.value = w.id
  pendingDeleteName.value = w.name || w.agentName
  showDeleteConfirm.value = true
}

async function deleteConfirmed() {
  if (!pendingDeleteId.value) return
  await api.fileWatchers.delete(pendingDeleteId.value)
  showDeleteConfirm.value = false
  pendingDeleteId.value = null
  await loadWatchers()
}

// ─── Model override helpers ──────────────────────────────

const effectiveProviderId = computed(() => {
  if (dlgProviderOverride.value) return dlgProviderOverride.value
  const agent = allAgents.value.find(a => a.id === dlgAgentId.value)
  return agent?.providerId || providerStore.activeProviderId
})

async function fetchModels(): Promise<void> {
  const pid = dlgProviderOverride.value || effectiveProviderId.value
  if (!pid) { dlgModels.value = []; return }
  loadingModels.value = true
  try {
    dlgModels.value = await providerStore.listModels(pid, 'llm')
  } catch {
    dlgModels.value = []
  } finally {
    loadingModels.value = false
  }
}

function onProviderChange(pid: string): void {
  dlgProviderOverride.value = pid
  dlgModelOverride.value = ''
  dlgModels.value = []
  if (pid) fetchModels()
}

watch(showDialog, (open) => {
  if (open && (dlgProviderOverride.value || effectiveProviderId.value)) {
    fetchModels()
  }
})

// ─── CustomSelect groups ─────────────────────────────────

const agentGroups = computed((): SelectOptionGroup[] => [{
  options: allAgents.value.map(a => {
    let imgSrc: string | null = a.iconUrl || null
    if (!imgSrc) {
      const prov = providerStore.providers.find(p => p.id === a.providerId)
      if (prov) imgSrc = logoUrl(prov.type)
    }
    return { value: a.id, label: a.name, imgSrc }
  })
}])

const providerGroups = computed((): SelectOptionGroup[] => [{
  options: [
    { value: '', label: 'Use agent default', iconName: 'lucide:settings' },
    ...providerStore.providers.map(p => ({
      value: p.id,
      label: p.name,
      imgSrc: logoUrl(p.type),
    }))
  ]
}])

const modelGroups = computed((): SelectOptionGroup[] => [{
  options: [
    { value: '', label: 'Use agent default', iconName: 'lucide:settings' },
    ...dlgModels.value.map(m => ({ value: m, label: m }))
  ]
}])

// ─── Tabs ────────────────────────────────────────────────

const tabs: TabDef<'file-watchers'>[] = [
  { value: 'file-watchers', label: 'File Watchers', icon: 'lucide:eye' }
]

const tabsWithBadges = computed(() =>
  tabs.map(t => ({
    ...t,
    badge: watchers.value.length
  }))
)

// ─── Load & Poll ─────────────────────────────────────────

async function loadWatchers() {
  try {
    watchers.value = await api.fileWatchers.list()
  } catch {
    // silently ignore
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadWatchers()
  pollTimer = setInterval(loadWatchers, 10_000)
})

onUnmounted(() => {
  clearInterval(pollTimer)
})
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-3xl mx-auto py-8 px-6">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold text-zinc-100">
            Triggers
          </h1>
          <p class="text-sm text-zinc-400 mt-1">
            Monitor files and folders — trigger agents on change
          </p>
        </div>
        <button
          class="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-sm font-medium text-white transition-colors"
          @click="openAddDialog"
        >
          <Icon
            icon="lucide:plus"
            class="w-4 h-4"
          />
          Add Watcher
        </button>
      </div>

      <TabBar
        v-model="activeTab"
        :tabs="tabsWithBadges"
        class="mb-6"
      />

      <!-- Loading -->
      <div
        v-if="loading"
        class="text-center py-12 text-zinc-400"
      >
        Loading…
      </div>

      <!-- Empty state -->
      <div
        v-else-if="!watchers.length"
        class="text-center py-12"
      >
        <Icon
          icon="lucide:eye-off"
          class="w-12 h-12 mx-auto text-zinc-600 mb-3"
        />
        <p class="text-zinc-400">
          No file watchers configured yet
        </p>
        <button
          class="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors"
          @click="openAddDialog"
        >
          Create File Watcher
        </button>
      </div>

      <!-- Watcher list -->
      <div
        v-else
        class="space-y-3 mt-4"
      >
        <div
          v-for="w in watchers"
          :key="w.id"
          class="bg-zinc-800/60 border border-zinc-700/60 rounded-xl p-4 flex items-start gap-4"
        >
          <!-- Agent icon -->
          <div class="w-10 h-10 rounded-full bg-zinc-700 flex items-center justify-center shrink-0 overflow-hidden mt-0.5">
            <img
              v-if="w.agentIconUrl"
              :src="w.agentIconUrl"
              class="w-full h-full object-cover"
            >
            <Icon
              v-else
              icon="lucide:bot"
              class="w-5 h-5 text-zinc-400"
            />
          </div>

          <!-- Info -->
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <span class="font-medium text-zinc-100 truncate">{{ w.name || 'Unnamed watcher' }}</span>
              <span
                v-if="w.isRunning"
                class="px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-amber-500/20 text-amber-400"
              >RUNNING</span>
              <span
                v-else-if="w.isWatching"
                class="px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-green-500/20 text-green-400"
              >WATCHING</span>
              <span
                v-else
                class="px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-zinc-500/20 text-zinc-500"
              >STOPPED</span>
            </div>

            <div class="text-xs text-zinc-400 space-y-0.5">
              <div class="flex items-center gap-1.5">
                <Icon
                  icon="lucide:bot"
                  class="w-3 h-3"
                />
                <span>{{ w.agentName }}</span>
              </div>
              <div class="flex items-center gap-1.5">
                <Icon
                  icon="lucide:folder"
                  class="w-3 h-3"
                />
                <span class="truncate">{{ w.paths.join(', ') }}</span>
              </div>
              <div class="flex items-center gap-1.5">
                <Icon
                  icon="lucide:timer"
                  class="w-3 h-3"
                />
                <span>{{ w.debounceMs / 1000 }}s debounce</span>
              </div>
            </div>
          </div>

          <!-- Actions -->
          <div class="flex items-center gap-1 shrink-0">
            <ToggleSwitch
              :model-value="w.enabled"
              size="sm"
              color="emerald"
              :title="w.enabled ? 'Disable' : 'Enable'"
              @update:model-value="toggleWatcher(w.id, !w.enabled)"
            />
            <button
              class="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
              title="Edit"
              @click="openEditDialog(w)"
            >
              <Icon
                icon="lucide:pencil"
                class="w-4 h-4"
              />
            </button>
            <button
              class="p-1.5 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
              title="Delete"
              @click="confirmDelete(w)"
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

    <!-- Create/Edit Dialog -->
    <ModalDialog
      :show="showDialog"
      :title="editingId ? 'Edit File Watcher' : 'New File Watcher'"
      max-width="max-w-2xl"
      @close="showDialog = false"
    >
      <div class="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
        <!-- Left column -->
        <div class="space-y-4">
          <!-- Name -->
          <div>
            <label class="block text-xs text-zinc-400 mb-1">Name</label>
            <input
              v-model="dlgName"
              type="text"
              placeholder="My Watcher"
              class="w-full bg-zinc-800 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
          </div>

          <!-- Agent (only for new) -->
          <div v-if="!editingId">
            <label class="block text-xs text-zinc-400 mb-1">Agent</label>
            <CustomSelect
              v-model="dlgAgentId"
              :groups="agentGroups"
              placeholder="Select an agent…"
              placeholder-icon="lucide:bot"
            />
          </div>

          <!-- Paths -->
          <div>
            <label class="block text-xs text-zinc-400 mb-1">Paths to watch (one per line)</label>
            <textarea
              v-model="dlgPaths"
              rows="3"
              placeholder="/home/user/project/src&#10;/home/user/project/config"
              class="w-full bg-zinc-800 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
            />
          </div>

          <!-- Ignore patterns -->
          <div>
            <label class="block text-xs text-zinc-400 mb-1">Ignore patterns (one glob per line)</label>
            <textarea
              v-model="dlgIgnorePatterns"
              rows="2"
              placeholder="node_modules/**&#10;.git/**"
              class="w-full bg-zinc-800 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
            />
          </div>
        </div>

        <!-- Right column -->
        <div class="space-y-4">
          <!-- Prompt -->
          <div>
            <label class="block text-xs text-zinc-400 mb-1">Prompt (optional instructions for the agent)</label>
            <textarea
              v-model="dlgPrompt"
              rows="5"
              placeholder="Analyze the changes and update the documentation…"
              class="w-full bg-zinc-800 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
            />
          </div>

          <!-- Debounce -->
          <div>
            <label class="block text-xs text-zinc-400 mb-1">Debounce (seconds after last change)</label>
            <input
              v-model.number="dlgDebounceMs"
              type="number"
              min="1"
              max="300"
              class="w-32 bg-zinc-800 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
          </div>

          <!-- Provider override -->
          <div>
            <label class="block text-xs text-zinc-400 mb-1">Provider override (optional)</label>
            <CustomSelect
              :model-value="dlgProviderOverride"
              :groups="providerGroups"
              placeholder="Use agent default"
              placeholder-icon="lucide:settings"
              @change="onProviderChange"
            />
          </div>

          <!-- Model override -->
          <div>
            <label class="block text-xs text-zinc-400 mb-1">Model override (optional)</label>
            <CustomSelect
              v-model="dlgModelOverride"
              :groups="modelGroups"
              placeholder="Use agent default"
              placeholder-icon="lucide:settings"
            />
          </div>
        </div>
      </div>

      <template #actions>
        <div class="flex justify-end gap-3">
          <button
            class="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            @click="showDialog = false"
          >
            Cancel
          </button>
          <button
            class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
            :disabled="saving || !dlgPaths.trim() || (!editingId && !dlgAgentId)"
            @click="save"
          >
            {{ saving ? 'Saving…' : (editingId ? 'Update' : 'Create') }}
          </button>
        </div>
      </template>
    </ModalDialog>

    <!-- Delete confirmation -->
    <ModalDialog
      :show="showDeleteConfirm"
      title="Delete File Watcher"
      @close="showDeleteConfirm = false"
    >
      <p class="text-sm text-zinc-300">
        Delete the watcher for <strong>{{ pendingDeleteName }}</strong>? This will stop monitoring and cannot be undone.
      </p>
      <template #actions>
        <div class="flex justify-end gap-3">
          <button
            class="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            @click="showDeleteConfirm = false"
          >
            Cancel
          </button>
          <button
            class="px-4 py-2 bg-red-600 hover:bg-red-500 text-white text-sm rounded-lg transition-colors"
            @click="deleteConfirmed"
          >
            Delete
          </button>
        </div>
      </template>
    </ModalDialog>
  </div>
</template>
