<script setup lang="ts">
import { ref, reactive, onBeforeUnmount } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { api } from '../../api/client'
import { Icon } from '@iconify/vue'
import BaseCard from '../shared/BaseCard.vue'

const importFile = ref<File | null>(null)
const importing = ref(false)
const importError = ref('')
const importResults = ref<Record<string, { restored: number; errors: string[] }> | null>(null)
const previewData = ref<{ version: number; createdAt: string; modules: Record<string, { count: number }> } | null>(null)
const importModules = reactive<Record<string, boolean>>({})
const previewing = ref(false)
const resetting = ref(false)
const resetError = ref('')

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

function onFileChange(event: Event): void {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  importFile.value = file
  importResults.value = null
  importError.value = ''
  previewData.value = null
  doPreview()
}

async function doPreview(): Promise<void> {
  if (!importFile.value) return
  previewing.value = true
  try {
    const manifest = await api.backup.previewBackup(importFile.value)
    previewData.value = manifest
    for (const key of Object.keys(manifest.modules)) {
      importModules[key] = true
    }
  } catch (e) {
    importError.value = (e as Error).message
  } finally {
    previewing.value = false
  }
}

async function doImport(): Promise<void> {
  if (!importFile.value || !previewData.value) return

  const selected = Object.entries(importModules)
    .filter(([, v]) => v)
    .map(([k]) => k)
  if (!selected.length) return

  importing.value = true
  importError.value = ''
  importResults.value = null
  try {
    const res = await api.backup.importBackup(importFile.value, selected)
    importResults.value = res.results
    setTimeout(() => window.location.reload(), 1500)
  } catch (e) {
    importError.value = (e as Error).message
  } finally {
    importing.value = false
  }
}

function clearImport(): void {
  importFile.value = null
  previewData.value = null
  importResults.value = null
  importError.value = ''
  Object.keys(importModules).forEach(k => delete importModules[k])
}

async function doReset(): Promise<void> {
  resetting.value = true
  resetError.value = ''
  try {
    await api.backup.resetApp()
    window.location.reload()
  } catch (e) {
    resetError.value = (e as Error).message
  } finally {
    resetting.value = false
  }
}

// Warn user before navigating away during import
onBeforeRouteLeave((_to, _from, next) => {
  if (importing.value) {
    const leave = window.confirm('An import is in progress. Leaving this page may interrupt it. Are you sure?')
    next(leave)
  } else {
    next()
  }
})

// Warn on browser close/refresh during import
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (importing.value) {
    e.preventDefault()
  }
}
window.addEventListener('beforeunload', onBeforeUnload)
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
})
</script>

<template>
  <div class="space-y-8">
    <!-- Import warning banner — visible only during active import -->
    <div
      v-if="importing"
      class="flex items-center gap-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30"
    >
      <Icon
        icon="lucide:loader-2"
        class="w-5 h-5 text-amber-400 animate-spin shrink-0"
      />
      <div>
        <p class="text-sm font-medium text-amber-300">
          Import in progress — please keep this page open
        </p>
        <p class="text-xs text-amber-400/70 mt-0.5">
          Navigating away or closing the browser may interrupt the restore process.
        </p>
      </div>
    </div>

    <!-- ═══════════════════ RESTORE ═══════════════════ -->
    <section>
      <BaseCard class="p-4 space-y-4">
        <!-- File picker -->
        <div
          v-if="!previewData && !importResults"
          class="relative"
        >
          <label
            class="flex flex-col items-center justify-center gap-2 py-8 border-2 border-dashed border-theme-600 rounded-lg hover:border-theme-500 cursor-pointer transition-colors"
          >
            <Icon
              icon="lucide:upload-cloud"
              class="w-8 h-8 text-theme-500"
            />
            <span class="text-sm text-theme-400">Click to select a backup file</span>
            <span class="text-[11px] text-theme-600">.zip files only</span>
            <input
              type="file"
              accept=".zip"
              class="hidden"
              @change="onFileChange"
            >
          </label>
          <div
            v-if="previewing"
            class="absolute inset-0 bg-theme-800/80 rounded-lg flex items-center justify-center"
          >
            <Icon
              icon="lucide:loader-2"
              class="w-5 h-5 text-accent-400 animate-spin"
            />
          </div>
        </div>

        <!-- Preview -->
        <template v-if="previewData && !importResults">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm text-theme-200 font-medium">
                {{ importFile?.name }}
              </p>
              <p class="text-[11px] text-theme-500">
                Created {{ new Date(previewData.createdAt).toLocaleString() }}
              </p>
            </div>
            <button
              class="text-xs text-theme-500 hover:text-theme-300 transition-colors"
              @click="clearImport"
            >
              Change file
            </button>
          </div>

          <div class="space-y-2">
            <p class="text-xs text-theme-400">
              Select modules to restore:
            </p>
            <label
              v-for="(info, key) in previewData.modules"
              :key="key"
              class="flex items-center gap-3 p-3 rounded-lg border transition-colors cursor-pointer"
              :class="importModules[key] ? 'border-green-500/40 bg-green-500/5' : 'border-theme-700 bg-theme-900 hover:border-theme-600'"
            >
              <input
                v-model="importModules[key]"
                type="checkbox"
                class="h-4 w-4 accent-green-600 shrink-0"
              >
              <Icon
                :icon="moduleLabels[key]?.icon || 'lucide:package'"
                class="w-4 h-4 text-theme-400 shrink-0"
              />
              <div class="flex-1">
                <span class="text-sm text-theme-200">{{ moduleLabels[key]?.label || key }}</span>
                <span class="text-xs text-theme-500 ml-2">{{ info.count }} item{{ info.count !== 1 ? 's' : '' }}</span>
              </div>
            </label>
          </div>

          <div class="flex items-center gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <Icon
              icon="lucide:alert-triangle"
              class="w-4 h-4 text-amber-400 shrink-0"
            />
            <p class="text-xs text-amber-400/90">
              Restoring will overwrite existing data for the selected modules.
            </p>
          </div>

          <button
            :disabled="importing || !Object.values(importModules).some(Boolean)"
            class="w-full px-4 py-2.5 bg-green-600 hover:bg-green-500 disabled:bg-theme-700 disabled:text-theme-500 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
            @click="doImport"
          >
            <Icon
              v-if="importing"
              icon="lucide:loader-2"
              class="w-4 h-4 animate-spin"
            />
            <Icon
              v-else
              icon="lucide:upload"
              class="w-4 h-4"
            />
            {{ importing ? 'Restoring...' : 'Restore Selected' }}
          </button>
        </template>

        <!-- Results -->
        <template v-if="importResults">
          <div class="space-y-3">
            <div class="flex items-center gap-2">
              <Icon
                icon="lucide:check-circle"
                class="w-5 h-5 text-green-400"
              />
              <span class="text-sm font-medium text-theme-200">Restore Complete</span>
            </div>

            <div
              v-for="(res, key) in importResults"
              :key="key"
              class="flex items-center gap-3 p-3 rounded-lg bg-theme-900 border border-theme-700"
            >
              <Icon
                :icon="moduleLabels[key]?.icon || 'lucide:package'"
                class="w-4 h-4 text-theme-400 shrink-0"
              />
              <div class="flex-1">
                <span class="text-sm text-theme-200">{{ moduleLabels[key]?.label || key }}</span>
                <span class="text-xs text-green-400 ml-2">{{ res.restored }} restored</span>
              </div>
              <Icon
                v-if="res.errors.length === 0"
                icon="lucide:check"
                class="w-4 h-4 text-green-400"
              />
              <Icon
                v-else
                icon="lucide:alert-circle"
                class="w-4 h-4 text-amber-400"
              />
            </div>

            <template
              v-for="(res, key) in importResults"
              :key="'err-'+key"
            >
              <div
                v-if="res.errors.length > 0"
                class="text-xs text-red-400 space-y-1"
              >
                <p
                  v-for="(err, i) in res.errors"
                  :key="i"
                >
                  {{ moduleLabels[key]?.label || key }}: {{ err }}
                </p>
              </div>
            </template>
          </div>

          <button
            class="w-full px-4 py-2 bg-theme-700 hover:bg-theme-600 text-theme-300 text-sm rounded-lg transition-colors"
            @click="clearImport"
          >
            Done
          </button>
        </template>

        <div
          v-if="importError"
          class="text-xs text-red-400"
        >
          {{ importError }}
        </div>
      </BaseCard>
    </section>
  </div>
</template>
