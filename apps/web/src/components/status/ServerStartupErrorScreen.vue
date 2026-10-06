<script setup lang="ts">
import { computed, ref } from 'vue'
import { Icon } from '@iconify/vue'
import type { ServerStartupError } from '../../api/types'
import { useAppUpdater } from '../../composables/useAppUpdater'
import AppUpdatePanel from '../settings/AppUpdatePanel.vue'

const props = defineProps<{
  error: ServerStartupError
  serverVersion: string
}>()

const electron = (window as unknown as { electron?: { quitApp?: () => Promise<void> } }).electron
const { isElectron } = useAppUpdater()
const copied = ref(false)

const isVersionMismatch = computed(() => props.error.code === 'database_version_mismatch')
const title = computed(() => isVersionMismatch.value
  ? 'Your data needs a newer version of Cynosure'
  : 'Cynosure could not open its database')
const details = computed(() => {
  const rows: [string, string][] = [['Cynosure version', props.serverVersion || 'unknown']]
  if (isVersionMismatch.value) {
    rows.push(['Database schema', `v${props.error.databaseVersion}`])
    rows.push(['Supported schema', `up to v${props.error.supportedVersion}`])
  }
  if (props.error.databasePath) rows.push(['Database file', props.error.databasePath])
  return rows
})

async function copyDetails(): Promise<void> {
  const text = [title.value, ...details.value.map(([label, value]) => `${label}: ${value}`), `Error: ${props.error.message}`].join('\n')
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch { /* Clipboard access can be denied; the details remain visible on screen. */ }
}
</script>

<template>
  <div class="flex h-screen items-center justify-center overflow-y-auto bg-theme-950 p-4 text-theme-100 antialiased">
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="startup-error-title"
      aria-describedby="startup-error-description"
      class="w-full max-w-lg rounded-2xl border border-theme-800 bg-theme-900 p-6 shadow-2xl"
    >
      <div class="mb-4 flex items-center gap-3">
        <div class="rounded-lg bg-red-500/20 p-2 text-status-danger">
          <Icon
            icon="lucide:database-zap"
            class="h-6 w-6"
          />
        </div>
        <h1
          id="startup-error-title"
          class="text-lg font-semibold text-theme-100"
        >
          {{ title }}
        </h1>
      </div>

      <div
        id="startup-error-description"
        class="space-y-3 text-sm leading-relaxed text-ink-secondary"
      >
        <template v-if="isVersionMismatch">
          <p>
            Your database was last opened by a newer version of Cynosure. This version can't read it, so it stopped before making any changes.
          </p>
          <p>
            {{ isElectron ? 'Update Cynosure to continue.' : 'Update the Cynosure server, then restart it.' }}
          </p>
        </template>
        <p v-else>
          The server ran into an error while opening its database, so Cynosure can't start. Restart Cynosure to try again. If it keeps happening, include the details below when you report it.
        </p>
      </div>

      <dl class="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-xl border border-theme-800 bg-theme-950/50 p-4 text-sm">
        <template
          v-for="[label, value] in details"
          :key="label"
        >
          <dt class="text-ink-muted">
            {{ label }}
          </dt>
          <dd class="min-w-0 break-all text-theme-200">
            {{ value }}
          </dd>
        </template>
      </dl>

      <details class="mt-3 text-sm">
        <summary class="cursor-pointer text-ink-muted hover:text-theme-200">
          Error message
        </summary>
        <pre class="mt-2 whitespace-pre-wrap break-words rounded-lg bg-theme-950/50 p-3 font-mono text-xs text-theme-300">{{ error.message }}</pre>
      </details>

      <div
        v-if="isVersionMismatch && isElectron"
        class="mt-5 border-t border-theme-800 pt-5"
      >
        <AppUpdatePanel />
      </div>

      <div class="mt-6 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          class="rounded-lg border border-theme-700 bg-theme-800 px-4 py-2 text-sm font-medium text-theme-200 transition hover:bg-theme-700"
          @click="copyDetails"
        >
          {{ copied ? 'Copied' : 'Copy details' }}
        </button>
        <button
          v-if="electron?.quitApp"
          type="button"
          class="rounded-lg border border-theme-700 bg-theme-800 px-4 py-2 text-sm font-medium text-theme-200 transition hover:bg-theme-700"
          @click="electron.quitApp()"
        >
          Quit Cynosure
        </button>
      </div>
    </div>
  </div>
</template>
