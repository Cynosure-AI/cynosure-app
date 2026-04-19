<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../../api/client'
import type { AgentDefinition, FileWatcher } from '../../api/types'
import { useProviderStore } from '../../stores/provider.store'
import { Icon } from '@iconify/vue'
import CustomSelect, { type SelectOptionGroup } from '../../components/shared/CustomSelect.vue'
import { useProviderLogos } from '../../composables/useProviderLogos'

const route = useRoute()
const router = useRouter()
const providerStore = useProviderStore()
const { logoUrl } = useProviderLogos()

const watcher = ref<FileWatcher | null>(null)
const allAgents = ref<AgentDefinition[]>([])
const loading = ref(true)
const saving = ref(false)
const saveMessage = ref('')
const promptTextarea = ref<HTMLTextAreaElement | null>(null)

function resizePrompt() {
  nextTick(() => {
    const el = promptTextarea.value
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  })
}

// Editable fields
const dlgName = ref('')
const dlgAgentId = ref('')
const dlgPaths = ref('')
const dlgIgnorePatterns = ref('')
const dlgPrompt = ref('')
const dlgDebounceMs = ref(5)
const dlgModelOverride = ref('')
const dlgProviderOverride = ref('')
const dlgModels = ref<string[]>([])
const loadingModels = ref(false)

const watcherId = computed(() => route.params.id as string)

function populateFields(w: FileWatcher) {
  dlgName.value = w.name || ''
  dlgAgentId.value = w.agentId
  dlgPaths.value = w.paths.join('\n')
  dlgIgnorePatterns.value = w.ignorePatterns.join('\n')
  dlgPrompt.value = w.prompt || ''
  dlgDebounceMs.value = Math.round(w.debounceMs / 1000)
  dlgModelOverride.value = w.modelOverride || ''
  dlgProviderOverride.value = w.providerOverride || ''
}

async function loadWatcher() {
  loading.value = true
  try {
    const [watchers, agents] = await Promise.all([
      api.fileWatchers.list(),
      api.agents.list(),
    ])
    allAgents.value = agents
    const found = watchers.find(w => w.id === watcherId.value)
    if (!found) {
      router.push('/triggers/file-watchers')
      return
    }
    watcher.value = found
    populateFields(found)
  } finally {
    loading.value = false
  }
}

async function save() {
  if (!watcher.value) return
  const paths = dlgPaths.value.split('\n').map(p => p.trim()).filter(Boolean)
  if (!paths.length) return

  saving.value = true
  try {
    const ignorePatterns = dlgIgnorePatterns.value.split('\n').map(p => p.trim()).filter(Boolean)
    const debounceMs = Math.max(1000, dlgDebounceMs.value * 1000)

    await api.fileWatchers.update(watcherId.value, {
      name: dlgName.value.trim(),
      agentId: dlgAgentId.value,
      paths,
      ignorePatterns,
      prompt: dlgPrompt.value,
      debounceMs,
      modelOverride: dlgModelOverride.value,
      providerOverride: dlgProviderOverride.value,
    })
    saveMessage.value = 'Saved'
    setTimeout(() => saveMessage.value = '', 2000)

    // Refresh data
    const watchers = await api.fileWatchers.list()
    const found = watchers.find(w => w.id === watcherId.value)
    if (found) watcher.value = found
  } finally {
    saving.value = false
  }
}

// ─── Model override helpers ──────────────────────────────

const effectiveProviderId = computed(() => {
  if (dlgProviderOverride.value) return dlgProviderOverride.value
  if (!watcher.value) return providerStore.lastUsedProviderId
  const agent = allAgents.value.find(a => a.id === dlgAgentId.value)
  return agent?.providerId || providerStore.lastUsedProviderId
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

watch(() => watcher.value, (w) => {
  if (w && (dlgProviderOverride.value || effectiveProviderId.value)) {
    fetchModels()
  }
})

// ─── CustomSelect groups ─────────────────────────────────

const agentGroups = computed((): SelectOptionGroup[] => [{
  options: allAgents.value.map(a => ({
    value: a.id,
    label: a.name,
    imgSrc: a.iconUrl || undefined,
    iconName: a.iconUrl ? undefined : 'lucide:bot',
  }))
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

onMounted(loadWatcher)
watch(dlgPrompt, resizePrompt, { immediate: true })
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-3xl mx-auto py-8 px-6">
      <!-- Loading -->
      <div
        v-if="loading"
        class="text-center py-12 text-zinc-400"
      >
        Loading…
      </div>

      <template v-else-if="watcher">
        <!-- Back + Title -->
        <div class="flex items-center justify-between mb-6">
          <div class="flex items-center gap-3">
            <button
              class="p-1.5 text-zinc-500 hover:text-zinc-300 transition-colors"
              @click="router.push('/triggers/file-watchers')"
            >
              <Icon
                icon="lucide:arrow-left"
                class="w-5 h-5"
              />
            </button>
            <div class="w-9 h-9 rounded-full bg-zinc-700 flex items-center justify-center shrink-0 overflow-hidden">
              <img
                v-if="watcher.agentIconUrl"
                :src="watcher.agentIconUrl"
                class="w-full h-full object-cover"
              >
              <Icon
                v-else
                icon="lucide:eye"
                class="w-5 h-5 text-zinc-400"
              />
            </div>
            <div>
              <h1 class="text-2xl font-bold text-zinc-100">
                {{ watcher.name || 'Unnamed watcher' }}
              </h1>
              <p class="text-sm text-zinc-400 mt-0.5">
                Agent: {{ watcher.agentName }}
              </p>
            </div>
          </div>

          <div class="flex items-center gap-3">
            <span
              v-if="watcher.isRunning"
              class="px-2 py-1 text-xs font-semibold rounded-full bg-amber-500/20 text-amber-400"
            >RUNNING</span>
            <span
              v-else-if="watcher.isWatching"
              class="px-2 py-1 text-xs font-semibold rounded-full bg-green-500/20 text-green-400"
            >WATCHING</span>
            <span
              v-else
              class="px-2 py-1 text-xs font-semibold rounded-full bg-zinc-500/20 text-zinc-500"
            >STOPPED</span>
            <span
              v-if="saveMessage"
              class="text-sm text-green-400"
            >{{ saveMessage }}</span>
            <button
              class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
              :disabled="saving || !dlgPaths.trim()"
              @click="save"
            >
              {{ saving ? 'Saving…' : 'Save Changes' }}
            </button>
          </div>
        </div>

        <!-- Form -->
        <div class="space-y-6">
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

          <!-- Agent -->
          <div>
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
              rows="4"
              placeholder="/home/user/project/src&#10;/home/user/project/config"
              class="w-full bg-zinc-800 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
            />
          </div>

          <!-- Ignore patterns -->
          <div>
            <label class="block text-xs text-zinc-400 mb-1">Ignore patterns (one glob per line)</label>
            <textarea
              v-model="dlgIgnorePatterns"
              rows="3"
              placeholder="node_modules/**&#10;.git/**"
              class="w-full bg-zinc-800 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
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

          <!-- Provider/Model overrides -->
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label class="block text-xs text-zinc-400 mb-1">Provider override</label>
              <CustomSelect
                :model-value="dlgProviderOverride"
                :groups="providerGroups"
                placeholder="Use agent default"
                placeholder-icon="lucide:settings"
                @change="onProviderChange"
              />
            </div>
            <div>
              <label class="block text-xs text-zinc-400 mb-1">Model override</label>
              <CustomSelect
                v-model="dlgModelOverride"
                :groups="modelGroups"
                placeholder="Use agent default"
                placeholder-icon="lucide:settings"
              />
            </div>
          </div>

          <!-- Prompt -->
          <div>
            <label class="block text-xs text-zinc-400 mb-1">Prompt (optional instructions for the agent)</label>
            <textarea
              ref="promptTextarea"
              v-model="dlgPrompt"
              placeholder="Analyze the changes and update the documentation…"
              class="w-full bg-zinc-800 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 resize-vertical overflow-hidden"
              style="min-height: 5rem"
              @input="resizePrompt"
            />
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
