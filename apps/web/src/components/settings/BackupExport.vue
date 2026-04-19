<script setup lang="ts">
import { ref, reactive } from 'vue'
import { api } from '../../api/client'
import { Icon } from '@iconify/vue'

const exportModules = reactive({
  agents: true,
  providers: true,
  mcp: true,
  settings: true,
  channels: true,
  memory: true,
  conversations: true,
  usage: true
})
const exporting = ref(false)
const exportError = ref('')

const moduleLabels: Record<string, { label: string; icon: string; description: string }> = {
  agents: { label: 'Agents', icon: 'lucide:bot', description: 'Agent definitions, system prompts, and configuration files' },
  providers: { label: 'LLM Providers', icon: 'lucide:cpu', description: 'Provider configs and API keys' },
  mcp: { label: 'MCP Servers', icon: 'lucide:plug', description: 'MCP server configurations and connection settings' },
  settings: { label: 'Settings', icon: 'lucide:sliders-horizontal', description: 'Tool approvals, cron jobs, and app settings' },
  channels: { label: 'Channels', icon: 'lucide:radio', description: 'Channel configurations (Telegram, etc.)' },
  memory: { label: 'Memory Spaces', icon: 'lucide:book-open', description: 'Memory space definitions, agent assignments, and document content (re-embedded on import)' },
  conversations: { label: 'Conversations', icon: 'lucide:message-square', description: 'Chat history and messages linked to agents (only restores for agents present in the DB)' },
  usage: { label: 'Usage Statistics', icon: 'lucide:bar-chart-3', description: 'Execution logs and step traces used for usage metrics' }
}

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
  <div class="bg-zinc-800 border border-zinc-700 rounded-xl p-4 space-y-4">
    <p class="text-xs text-zinc-500">
      Select which modules to include in the backup file.
    </p>

    <div class="grid grid-cols-2 gap-3">
      <label
        v-for="(meta, key) in moduleLabels"
        :key="key"
        class="flex items-start gap-3 p-3 rounded-lg border transition-colors cursor-pointer"
        :class="exportModules[key as keyof typeof exportModules] ? 'border-blue-500/40 bg-blue-500/5' : 'border-zinc-700 bg-zinc-900/50 hover:border-zinc-600'"
      >
        <input
          v-model="exportModules[key as keyof typeof exportModules]"
          type="checkbox"
          class="mt-0.5 h-4 w-4 accent-blue-600 shrink-0"
        >
        <div>
          <div class="flex items-center gap-1.5">
            <Icon
              :icon="meta.icon"
              class="w-3.5 h-3.5 text-zinc-400"
            />
            <span class="text-sm font-medium text-zinc-200">{{ meta.label }}</span>
          </div>
          <p class="text-[11px] text-zinc-500 mt-0.5">{{ meta.description }}</p>
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
      class="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
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
