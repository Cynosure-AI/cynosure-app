<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { api } from '../../api/client'
import { Icon } from '@iconify/vue'
import ModalDialog from '../shared/ModalDialog.vue'

const resetModules = [
  { key: 'conversations', label: 'Conversations', icon: 'lucide:message-square', description: 'Chat history, messages, tasks, attachments, and conversation indexes.' },
  { key: 'notifications', label: 'Notifications', icon: 'lucide:bell', description: 'Delivered and unread app notifications.' },
  { key: 'usage', label: 'Usage Statistics', icon: 'lucide:bar-chart-3', description: 'Execution logs, step traces, auxiliary model usage, and usage counters.' },
  { key: 'memory', label: 'Memory Spaces', icon: 'lucide:book-open', description: 'Memory space definitions, source files, assignments, and search indexes.' },
  { key: 'vectors', label: 'Vector Indexes', icon: 'lucide:database', description: 'Stored vector embeddings only. Memory source files and spaces stay in place.' },
  { key: 'entityGraph', label: 'Knowledge Graph', icon: 'lucide:network', description: 'Clears extracted knowledge, manual corrections, merges, relationships, evidence, and graph search data. Source files and ordinary search indexes stay in place.' },
  { key: 'agents', label: 'Agents', icon: 'lucide:bot', description: 'Agent definitions plus agent-owned schedules and channels.' },
  { key: 'providers', label: 'LLM Providers', icon: 'lucide:cpu', description: 'Provider configs and saved API keys.' },
  { key: 'mcp', label: 'MCP Servers', icon: 'lucide:plug', description: 'MCP server configurations and connection settings.' },
  { key: 'settings', label: 'Settings', icon: 'lucide:sliders-horizontal', description: 'App settings, tool approvals, cron jobs, and router caches.' },
  { key: 'channels', label: 'Channels', icon: 'lucide:radio', description: 'Messaging channel configurations.' },
]

const showResetConfirm = ref(false)
const resetConfirmText = ref('')
const resetting = ref(false)
const resetError = ref('')
const resetResults = ref<Record<string, { reset: boolean; errors: string[] }> | null>(null)
const selectedModules = reactive<Record<string, boolean>>(
  Object.fromEntries(resetModules.map((module) => [module.key, false]))
)

const selectedKeys = computed(() =>
  resetModules
    .filter((module) => selectedModules[module.key])
    .map((module) => module.key)
)
const selectedCount = computed(() => selectedKeys.value.length)
const fullResetSelected = computed(() => selectedCount.value === resetModules.length)
const confirmationWord = computed(() => fullResetSelected.value ? 'RESET' : 'CLEAR')

function selectAll(): void {
  for (const module of resetModules) selectedModules[module.key] = true
}

function clearSelection(): void {
  for (const module of resetModules) selectedModules[module.key] = false
}

function closeConfirm(): void {
  showResetConfirm.value = false
  resetConfirmText.value = ''
}

async function doReset(): Promise<void> {
  if (resetConfirmText.value !== confirmationWord.value || selectedCount.value === 0) return

  resetting.value = true
  resetError.value = ''
  resetResults.value = null
  try {
    const res = await api.backup.resetApp(selectedKeys.value)
    resetResults.value = res.results || null
    if (fullResetSelected.value) {
      window.location.reload()
      return
    }
    closeConfirm()
    clearSelection()
  } catch (e) {
    resetError.value = (e as Error).message
  } finally {
    resetting.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <p class="text-xs text-theme-400">
      Clear selected parts of Cynosure without forcing a full application reset. Choose only the data areas you want to remove.
    </p>

    <div class="flex flex-wrap items-center gap-2">
      <button
        class="px-3 py-1.5 bg-theme-800 hover:bg-theme-700 text-theme-300 text-xs rounded-lg transition-colors"
        @click="selectAll"
      >
        Select all
      </button>
      <button
        class="px-3 py-1.5 bg-theme-800 hover:bg-theme-700 text-theme-300 text-xs rounded-lg transition-colors"
        @click="clearSelection"
      >
        Clear selection
      </button>
      <span class="text-xs text-theme-500">
        {{ selectedCount }} selected
      </span>
    </div>

    <div class="grid gap-2 sm:grid-cols-2">
      <label
        v-for="module in resetModules"
        :key="module.key"
        class="flex items-start gap-3 p-3 rounded-lg border transition-colors cursor-pointer"
        :class="selectedModules[module.key] ? 'border-red-500/40 bg-red-500/5' : 'border-theme-700 bg-theme-900 hover:border-theme-600'"
      >
        <input
          v-model="selectedModules[module.key]"
          type="checkbox"
          class="mt-0.5 h-4 w-4 accent-red-600 shrink-0"
        >
        <Icon
          :icon="module.icon"
          class="w-4 h-4 text-theme-400 shrink-0 mt-0.5"
        />
        <span class="min-w-0">
          <span class="block text-sm text-theme-200">{{ module.label }}</span>
          <span class="block text-xs text-theme-500 mt-0.5 leading-relaxed">{{ module.description }}</span>
        </span>
      </label>
    </div>

    <div class="flex items-center gap-2 p-2.5 rounded-lg bg-red-500/10 border border-red-500/20">
      <Icon
        icon="lucide:alert-triangle"
        class="w-4 h-4 text-red-400 shrink-0"
      />
      <p class="text-xs text-red-400/90">
        Selected reset actions are irreversible. Export a backup first if you may need this data later.
      </p>
    </div>

    <div
      v-if="resetError"
      class="text-xs text-red-400"
    >
      {{ resetError }}
    </div>

    <div
      v-if="resetResults"
      class="space-y-1 text-xs"
    >
      <div
        v-for="module in resetModules.filter((item) => resetResults?.[item.key])"
        :key="module.key"
        class="flex items-center gap-2 text-theme-400"
      >
        <Icon
          :icon="resetResults[module.key].errors.length === 0 ? 'lucide:check' : 'lucide:alert-circle'"
          class="w-3.5 h-3.5"
          :class="resetResults[module.key].errors.length === 0 ? 'text-green-400' : 'text-amber-400'"
        />
        <span>{{ module.label }} {{ resetResults[module.key].errors.length === 0 ? 'cleared' : 'completed with errors' }}</span>
      </div>
    </div>

    <button
      :disabled="selectedCount === 0"
      class="w-full px-4 py-2.5 bg-red-600 hover:bg-red-500 disabled:bg-theme-700 disabled:text-theme-500 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
      @click="showResetConfirm = true"
    >
      <Icon
        icon="lucide:trash-2"
        class="w-4 h-4"
      />
      Reset Selected Data
    </button>
  </div>

  <ModalDialog
    :show="showResetConfirm"
    title="Reset Selected Data"
    icon="lucide:alert-triangle"
    icon-color="red"
    layer="nested"
    @close="closeConfirm"
  >
    <p class="text-sm text-theme-400 mb-4">
      This will permanently delete the selected data areas. This cannot be undone.
    </p>
    <div class="mb-4 flex flex-wrap gap-1.5">
      <span
        v-for="module in resetModules.filter((item) => selectedModules[item.key])"
        :key="module.key"
        class="px-2 py-1 rounded bg-red-500/10 text-red-300 text-xs"
      >
        {{ module.label }}
      </span>
    </div>
    <p class="text-sm text-theme-400 mb-2">
      Type <strong class="text-red-400">{{ confirmationWord }}</strong> to confirm:
    </p>
    <input
      v-model="resetConfirmText"
      type="text"
      :placeholder="`Type ${confirmationWord}`"
      class="w-full px-3 py-2 bg-theme-800 border border-theme-700 rounded-lg text-sm text-theme-200 placeholder-theme-600 focus:outline-none focus:border-red-500/50"
    >
    <template #actions>
      <button
        :disabled="resetConfirmText !== confirmationWord || resetting"
        class="w-full px-4 py-2.5 bg-red-600 hover:bg-red-500 disabled:bg-theme-700 disabled:text-theme-500 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
        @click="doReset"
      >
        <Icon
          v-if="resetting"
          icon="lucide:loader-2"
          class="w-4 h-4 animate-spin"
        />
        <Icon
          v-else
          icon="lucide:trash-2"
          class="w-4 h-4"
        />
        {{ resetting ? 'Resetting...' : 'Confirm Reset' }}
      </button>
      <button
        class="w-full px-4 py-2 text-theme-400 hover:text-theme-200 text-sm transition-colors"
        @click="closeConfirm"
      >
        Cancel
      </button>
    </template>
  </ModalDialog>
</template>
