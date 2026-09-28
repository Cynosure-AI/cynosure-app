<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Icon } from '@iconify/vue'
import { api } from '../../api/client'

const folders = ref<string[]>([])
const folderPath = ref('')
const loading = ref(true)
const busy = ref(false)
const error = ref('')
const electron = (window as unknown as { electron?: { chooseFileAccessDirectory?: () => Promise<string | null> } }).electron

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    folders.value = (await api.fileAccess.list()).folders
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

async function addFolder(): Promise<void> {
  if (!folderPath.value.trim() || busy.value) return
  busy.value = true
  error.value = ''
  try {
    folders.value = (await api.fileAccess.add(folderPath.value.trim())).folders
    folderPath.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

async function chooseFolder(): Promise<void> {
  const selected = await electron?.chooseFileAccessDirectory?.()
  if (selected) folderPath.value = selected
}

async function removeFolder(path: string): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    folders.value = (await api.fileAccess.remove(path)).folders
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

onMounted(refresh)
</script>

<template>
  <div class="space-y-6">
    <div>
      <h2 class="text-lg font-semibold text-theme-100">File Access</h2>
      <p class="mt-1 text-sm text-ink-muted">
        AI file tools can access these folders and everything inside them. Other folders require your approval when a tool tries to use them.
      </p>
    </div>

    <form class="flex flex-col gap-2 sm:flex-row" @submit.prevent="addFolder">
      <input
        v-model="folderPath"
        type="text"
        aria-label="Folder path"
        placeholder="Absolute folder path"
        class="min-w-0 flex-1 rounded-lg border border-theme-700 bg-theme-900 px-3 py-2 text-sm text-theme-100 placeholder:text-ink-muted focus:border-accent-500 focus:outline-none"
      >
      <button
        v-if="electron?.chooseFileAccessDirectory"
        type="button"
        class="rounded-lg border border-theme-700 px-3 py-2 text-sm text-theme-300 hover:bg-theme-800"
        @click="chooseFolder"
      >Browse</button>
      <button
        type="submit"
        :disabled="busy || !folderPath.trim()"
        class="rounded-lg accent-action bg-accent-600 px-4 py-2 text-sm font-medium text-accent-on disabled:opacity-50"
      >Add folder</button>
    </form>

    <p v-if="error" role="alert" class="text-sm text-status-danger">{{ error }}</p>
    <p v-if="loading" class="text-sm text-ink-muted">Loading folders…</p>
    <p v-else-if="!folders.length" class="rounded-lg border border-theme-800 bg-theme-900/50 p-4 text-sm text-ink-muted">
      No folders allowed yet. Cynosure will ask when an AI file tool first needs access.
    </p>
    <ul v-else class="divide-y divide-theme-800 rounded-lg border border-theme-800">
      <li v-for="folder in folders" :key="folder" class="flex items-center gap-3 px-4 py-3">
        <Icon icon="lucide:folder" class="h-4 w-4 shrink-0 text-accent-fg" />
        <span class="min-w-0 flex-1 break-all font-mono text-xs text-theme-200">{{ folder }}</span>
        <button
          type="button"
          :disabled="busy"
          class="shrink-0 rounded-md px-2 py-1 text-xs text-status-danger hover:bg-red-500/10 disabled:opacity-50"
          :aria-label="`Remove ${folder}`"
          @click="removeFolder(folder)"
        >Remove</button>
      </li>
    </ul>
  </div>
</template>
