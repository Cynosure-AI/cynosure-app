<script setup lang="ts">
import { onMounted, ref, reactive } from 'vue'
import { api } from '../../api/client'
import { Icon } from '@iconify/vue'

const exportModules = reactive({
  agents: true,
  providers: true,
  mcp: true,
  settings: true,
  channels: true,
  memory: true,
  knowledge: true,
  conversations: true,
  usage: true
})
const exporting = ref(false)
const exportError = ref('')
const summaryLoading = ref(true)
const summary = ref<Record<string, { count: number; details?: Record<string, number> }>>({})

const moduleLabels: Record<string, { label: string; icon: string; description: string }> = {
  agents: { label: 'Agents', icon: 'lucide:bot', description: 'Agent definitions, system prompts, and configuration files' },
  providers: { label: 'LLM Providers', icon: 'lucide:cpu', description: 'Provider configs and API keys' },
  mcp: { label: 'MCP Servers', icon: 'lucide:plug', description: 'MCP server configurations and connection settings' },
  settings: { label: 'Settings', icon: 'lucide:sliders-horizontal', description: 'Tool approvals, cron jobs, and app settings' },
  channels: { label: 'Channels', icon: 'lucide:radio', description: 'Channel configurations (Telegram, etc.)' },
  memory: { label: 'Memory Categories', icon: 'lucide:book-open', description: 'Memory category definitions, agent assignments, and document content (re-embedded on import)' },
  knowledge: { label: 'Knowledge Graph', icon: 'lucide:network', description: 'Extracted knowledge plus manual corrections, merges, and relationships' },
  conversations: { label: 'Conversations', icon: 'lucide:message-square', description: 'Chat history and messages linked to agents (only restores for agents present in the DB)' },
  usage: { label: 'Usage Statistics', icon: 'lucide:bar-chart-3', description: 'Execution logs and step traces used for usage metrics' }
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`
}

function moduleCountLabel(key: string): string {
  const module = summary.value[key]
  if (!module) return ''

  const details = module.details || {}
  switch (key) {
    case 'agents': return pluralize(module.count, 'Agent')
    case 'providers': return pluralize(module.count, 'Provider')
    case 'mcp': return pluralize(module.count, 'Server')
    case 'settings': return pluralize(module.count, 'Item')
    case 'channels': return pluralize(module.count, 'Channel')
    case 'memory':
      return `${pluralize(details.spaces || 0, 'Memory Space')} · ${pluralize(details.documents || 0, 'Document')}`
    case 'knowledge':
      return `${pluralize(details.entities || 0, 'Entity', 'Entities')} · ${pluralize(details.relationships || 0, 'Relationship')}`
    case 'conversations':
      return `${pluralize(details.conversations || 0, 'Conversation')} · ${pluralize(details.messages || 0, 'Message')}`
    case 'usage':
      return `${pluralize(details.runs || 0, 'Run')} · ${pluralize(details.steps || 0, 'Step')}`
    default: return pluralize(module.count, 'Item')
  }
}

onMounted(async () => {
  try {
    const result = await api.backup.getSummary()
    summary.value = result.modules
  } catch {
    // Counts are supplementary; exporting remains available if they cannot be loaded.
  } finally {
    summaryLoading.value = false
  }
})

async function doExport(): Promise<void> {
  const selected = Object.entries(exportModules)
    .filter(([, v]) => v)
    .map(([k]) => k)
  if (!selected.length) return

  exporting.value = true
  exportError.value = ''
  try {
    const blob = await api.backup.exportBackup(selected)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `cynosure-backup-${new Date().toISOString().slice(0, 10)}.zip`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  } catch (e) {
    exportError.value = (e as Error).message
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <p class="text-xs text-theme-500">
      Select which modules to include in the backup file.
    </p>

    <div class="grid grid-cols-2 gap-3">
      <label
        v-for="(meta, key) in moduleLabels"
        :key="key"
        class="flex items-start gap-3 p-3 rounded-lg border transition-colors cursor-pointer"
        :class="exportModules[key as keyof typeof exportModules] ? 'border-accent-500/40 bg-accent-500/5' : 'border-theme-700 bg-theme-900 hover:border-theme-600'"
      >
        <input
          v-model="exportModules[key as keyof typeof exportModules]"
          type="checkbox"
          class="mt-0.5 h-4 w-4 accent-accent-600 shrink-0"
        >
        <div>
          <div class="flex items-center gap-1.5">
            <Icon
              :icon="meta.icon"
              class="w-3.5 h-3.5 text-theme-400"
            />
            <span class="text-sm font-medium text-theme-200">{{ meta.label }}</span>
          </div>
          <div
            v-if="summaryLoading || moduleCountLabel(key)"
            class="text-[11px] font-medium text-accent-400 mt-1"
          >
            <span v-if="summaryLoading">Counting…</span>
            <span v-else>{{ moduleCountLabel(key) }}</span>
          </div>
          <p class="text-[11px] text-theme-500 mt-0.5">{{ meta.description }}</p>
        </div>
      </label>
    </div>

    <div
      v-if="exportError"
      class="text-xs text-red-400"
    >
      {{ exportError }}
    </div>

    <button
      :disabled="exporting || !Object.values(exportModules).some(Boolean)"
      class="w-full px-4 py-2.5 bg-accent-600 hover:bg-accent-500 disabled:bg-theme-700 disabled:text-theme-500 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
      @click="doExport"
    >
      <Icon
        v-if="exporting"
        icon="lucide:loader-2"
        class="w-4 h-4 animate-spin"
      />
      <Icon
        v-else
        icon="lucide:download"
        class="w-4 h-4"
      />
      {{ exporting ? 'Exporting...' : 'Download Backup' }}
    </button>
  </div>
</template>
