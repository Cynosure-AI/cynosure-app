<script setup lang="ts">
import { ref, reactive } from 'vue'
import { api } from '../../api/client'
import { Icon } from '@iconify/vue'
import ModalDialog from '../shared/ModalDialog.vue'

// ── Export state ──
const exportModules = reactive({
  agents: true,
  providers: true,
  mcp: true,
  settings: true,
  channels: true,
  memory: true
})
const exporting = ref(false)
const exportError = ref('')

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
    a.download = `openagent-backup-${new Date().toISOString().slice(0, 10)}.zip`
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

// ── Import state ──
const importFile = ref<File | null>(null)
const importing = ref(false)
const importError = ref('')
const importResults = ref<Record<string, { restored: number; errors: string[] }> | null>(null)
const previewData = ref<{ version: number; createdAt: string; modules: Record<string, { count: number }> } | null>(null)
const importModules = reactive<Record<string, boolean>>({})
const previewing = ref(false)

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
    // Pre-select all available modules
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

const moduleLabels: Record<string, { label: string; icon: string; description: string }> = {
  agents: { label: 'Agents', icon: 'lucide:bot', description: 'Agent definitions, system prompts, and configuration files' },
  providers: { label: 'LLM Providers', icon: 'lucide:cpu', description: 'Provider configs and API keys' },
  mcp: { label: 'MCP Servers', icon: 'lucide:plug', description: 'MCP server configurations and connection settings' },
  settings: { label: 'Settings', icon: 'lucide:sliders-horizontal', description: 'Tool approvals, cron jobs, and app settings' },
  channels: { label: 'Channels', icon: 'lucide:radio', description: 'Channel configurations (Telegram, etc.)' },
  memory: { label: 'Memory Spaces', icon: 'lucide:book-open', description: 'Memory space definitions, agent assignments, and document content (re-embedded on import)' }
}

// ── Reset state ──
const showResetConfirm = ref(false)
const resetConfirmText = ref('')
const resetting = ref(false)
const resetError = ref('')

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
</script>

<template>
  <div>
    <div class="mb-6">
      <h2 class="text-lg font-semibold text-zinc-200">
        Backup & Restore
      </h2>
      <p class="text-xs text-zinc-500 mt-1">
        Export your OpenAgent configuration as a zip file, or restore from a previous backup.
      </p>
    </div>

    <!-- ═══════════════════ EXPORT ═══════════════════ -->
    <section class="mb-8">
      <h3 class="text-sm font-semibold text-zinc-300 mb-3 flex items-center gap-2">
        <Icon
          icon="lucide:download"
          class="w-4 h-4 text-blue-400"
        />
        Export Backup
      </h3>
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
    </section>

    <!-- ═══════════════════ IMPORT ═══════════════════ -->
    <section>
      <h3 class="text-sm font-semibold text-zinc-300 mb-3 flex items-center gap-2">
        <Icon
          icon="lucide:upload"
          class="w-4 h-4 text-green-400"
        />
        Restore from Backup
      </h3>
      <div class="bg-zinc-800 border border-zinc-700 rounded-xl p-4 space-y-4">
        <!-- File picker -->
        <div
          v-if="!previewData && !importResults"
          class="relative"
        >
          <label
            class="flex flex-col items-center justify-center gap-2 py-8 border-2 border-dashed border-zinc-600 rounded-lg hover:border-zinc-500 cursor-pointer transition-colors"
          >
            <Icon
              icon="lucide:upload-cloud"
              class="w-8 h-8 text-zinc-500"
            />
            <span class="text-sm text-zinc-400">Click to select a backup file</span>
            <span class="text-[11px] text-zinc-600">.zip files only</span>
            <input
              type="file"
              accept=".zip"
              class="hidden"
              @change="onFileChange"
            >
          </label>
          <div
            v-if="previewing"
            class="absolute inset-0 bg-zinc-800/80 rounded-lg flex items-center justify-center"
          >
            <Icon
              icon="lucide:loader-2"
              class="w-5 h-5 text-blue-400 animate-spin"
            />
          </div>
        </div>

        <!-- Preview -->
        <template v-if="previewData && !importResults">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm text-zinc-200 font-medium">
                {{ importFile?.name }}
              </p>
              <p class="text-[11px] text-zinc-500">
                Created {{ new Date(previewData.createdAt).toLocaleString() }}
              </p>
            </div>
            <button
              class="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              @click="clearImport"
            >
              Change file
            </button>
          </div>

          <div class="space-y-2">
            <p class="text-xs text-zinc-400">
              Select modules to restore:
            </p>
            <label
              v-for="(info, key) in previewData.modules"
              :key="key"
              class="flex items-center gap-3 p-3 rounded-lg border transition-colors cursor-pointer"
              :class="importModules[key] ? 'border-green-500/40 bg-green-500/5' : 'border-zinc-700 bg-zinc-900/50 hover:border-zinc-600'"
            >
              <input
                v-model="importModules[key]"
                type="checkbox"
                class="h-4 w-4 accent-green-600 shrink-0"
              >
              <Icon
                :icon="moduleLabels[key]?.icon || 'lucide:package'"
                class="w-4 h-4 text-zinc-400 shrink-0"
              />
              <div class="flex-1">
                <span class="text-sm text-zinc-200">{{ moduleLabels[key]?.label || key }}</span>
                <span class="text-xs text-zinc-500 ml-2">{{ info.count }} item{{ info.count !== 1 ? 's' : '' }}</span>
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
            class="w-full px-4 py-2.5 bg-green-600 hover:bg-green-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
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
              <span class="text-sm font-medium text-zinc-200">Restore Complete</span>
            </div>

            <div
              v-for="(res, key) in importResults"
              :key="key"
              class="flex items-center gap-3 p-3 rounded-lg bg-zinc-900/50 border border-zinc-700"
            >
              <Icon
                :icon="moduleLabels[key]?.icon || 'lucide:package'"
                class="w-4 h-4 text-zinc-400 shrink-0"
              />
              <div class="flex-1">
                <span class="text-sm text-zinc-200">{{ moduleLabels[key]?.label || key }}</span>
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

            <!-- Show errors if any -->
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
            class="w-full px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-zinc-300 text-sm rounded-lg transition-colors"
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
      </div>
    </section>

    <!-- ═══════════════════ RESET ═══════════════════ -->
    <section class="mt-8">
      <h3 class="text-sm font-semibold text-zinc-300 mb-3 flex items-center gap-2">
        <Icon
          icon="lucide:trash-2"
          class="w-4 h-4 text-red-400"
        />
        Reset Application
      </h3>
      <div class="bg-zinc-800 border border-red-500/20 rounded-xl p-4 space-y-4">
        <p class="text-xs text-zinc-400">
          Permanently delete all data and reset OpenAgent to a clean state. This removes all agents, providers,
          conversations, memory spaces, MCP servers, channels, and settings.
        </p>

        <div class="flex items-center gap-2 p-2.5 rounded-lg bg-red-500/10 border border-red-500/20">
          <Icon
            icon="lucide:alert-triangle"
            class="w-4 h-4 text-red-400 shrink-0"
          />
          <p class="text-xs text-red-400/90">
            This action is irreversible. Consider exporting a backup first.
          </p>
        </div>

        <div
          v-if="resetError"
          class="text-xs text-red-400"
        >
          {{ resetError }}
        </div>

        <button
          class="w-full px-4 py-2.5 bg-red-600 hover:bg-red-500 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
          @click="showResetConfirm = true"
        >
          <Icon
            icon="lucide:trash-2"
            class="w-4 h-4"
          />
          Reset to Clean State
        </button>
      </div>
    </section>

    <!-- Reset confirmation modal -->
    <ModalDialog
      :show="showResetConfirm"
      title="Reset Application"
      icon="lucide:alert-triangle"
      icon-color="red"
      @close="showResetConfirm = false; resetConfirmText = ''"
    >
      <p class="text-sm text-zinc-400 mb-4">
        This will permanently delete <strong class="text-zinc-200">all data</strong> including agents, providers,
        conversations, memory, and settings. This cannot be undone.
      </p>
      <p class="text-sm text-zinc-400 mb-2">
        Type <strong class="text-red-400">RESET</strong> to confirm:
      </p>
      <input
        v-model="resetConfirmText"
        type="text"
        placeholder="Type RESET"
        class="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-red-500/50"
      >
      <template #actions>
        <button
          :disabled="resetConfirmText !== 'RESET' || resetting"
          class="w-full px-4 py-2.5 bg-red-600 hover:bg-red-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
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
          class="w-full px-4 py-2 text-zinc-400 hover:text-zinc-200 text-sm transition-colors"
          @click="showResetConfirm = false; resetConfirmText = ''"
        >
          Cancel
        </button>
      </template>
    </ModalDialog>
  </div>
</template>
