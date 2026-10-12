<script setup lang="ts">
import { ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import { api } from '../../api/client'
import ModalDialog from './ModalDialog.vue'

const props = defineProps<{
  show: boolean
  /** Folder to open first; falls back to the server user's home folder. */
  initialPath?: string
  title?: string
}>()

const emit = defineEmits<{
  close: []
  select: [path: string]
}>()

const currentPath = ref('')
const parentPath = ref<string | null>(null)
const homePath = ref('')
const directories = ref<{ name: string; path: string }[]>([])
const pathInput = ref('')
const showHidden = ref(false)
const loading = ref(false)
const error = ref('')

async function load(path?: string): Promise<boolean> {
  loading.value = true
  error.value = ''
  try {
    const listing = await api.fileAccess.directories(path, showHidden.value)
    currentPath.value = listing.path
    parentPath.value = listing.parent
    homePath.value = listing.home
    directories.value = listing.directories
    pathInput.value = listing.path
    return true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
    return false
  } finally {
    loading.value = false
  }
}

watch(() => props.show, async (show) => {
  if (!show) return
  const initial = props.initialPath?.trim()
  if (!(await load(initial || undefined)) && initial) await load()
}, { immediate: true })

watch(showHidden, () => {
  if (props.show && currentPath.value) void load(currentPath.value)
})

function goToInput(): void {
  const target = pathInput.value.trim()
  if (target && target !== currentPath.value) void load(target)
}

function choose(): void {
  if (!currentPath.value) return
  emit('select', currentPath.value)
  emit('close')
}
</script>

<template>
  <ModalDialog
    :show="show"
    :title="title || 'Choose folder'"
    icon="lucide:folder-open"
    max-width="max-w-lg"
    layer="nested"
    @close="emit('close')"
  >
    <div class="space-y-3">
      <div class="flex gap-2">
        <button
          type="button"
          class="shrink-0 rounded-lg border border-theme-700 p-2 text-theme-300 hover:bg-theme-800 disabled:opacity-40"
          :disabled="!parentPath || loading"
          aria-label="Parent folder"
          title="Parent folder"
          @click="parentPath && load(parentPath)"
        >
          <Icon
            icon="lucide:arrow-up"
            class="h-4 w-4"
          />
        </button>
        <button
          type="button"
          class="shrink-0 rounded-lg border border-theme-700 p-2 text-theme-300 hover:bg-theme-800 disabled:opacity-40"
          :disabled="!homePath || loading"
          aria-label="Home folder"
          title="Home folder"
          @click="load(homePath)"
        >
          <Icon
            icon="lucide:house"
            class="h-4 w-4"
          />
        </button>
        <input
          v-model="pathInput"
          type="text"
          aria-label="Current folder"
          class="min-w-0 flex-1 rounded-lg border border-theme-700 bg-theme-900 px-3 py-2 font-mono text-xs text-theme-100 focus:border-accent-500 focus:outline-none"
          @keydown.enter.prevent="goToInput"
        >
      </div>

      <p
        v-if="error"
        role="alert"
        class="text-sm text-status-danger"
      >
        {{ error }}
      </p>

      <div class="h-72 overflow-y-auto rounded-lg border border-theme-800">
        <p
          v-if="loading && !directories.length"
          class="p-4 text-sm text-ink-muted"
        >
          Loading folders…
        </p>
        <p
          v-else-if="!directories.length"
          class="p-4 text-sm text-ink-muted"
        >
          No subfolders.
        </p>
        <ul
          v-else
          class="divide-y divide-theme-800"
          :class="{ 'opacity-60': loading }"
        >
          <li
            v-for="directory in directories"
            :key="directory.path"
          >
            <button
              type="button"
              class="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-theme-200 hover:bg-theme-800"
              @click="load(directory.path)"
            >
              <Icon
                icon="lucide:folder"
                class="h-4 w-4 shrink-0 text-accent-fg"
              />
              <span class="min-w-0 flex-1 truncate">{{ directory.name }}</span>
              <Icon
                icon="lucide:chevron-right"
                class="h-4 w-4 shrink-0 text-ink-faint"
              />
            </button>
          </li>
        </ul>
      </div>

      <label class="flex items-center gap-2 text-xs text-ink-muted">
        <input
          v-model="showHidden"
          type="checkbox"
          class="accent-accent-500"
        >
        Show hidden folders
      </label>
    </div>

    <template #actions>
      <div class="flex justify-end gap-2">
        <button
          type="button"
          class="rounded-lg border border-theme-700 px-4 py-2 text-sm text-theme-300 hover:bg-theme-800"
          @click="emit('close')"
        >
          Cancel
        </button>
        <button
          type="button"
          :disabled="!currentPath || loading"
          class="rounded-lg accent-action bg-accent-600 px-4 py-2 text-sm font-medium text-accent-on disabled:opacity-50"
          @click="choose"
        >
          Select this folder
        </button>
      </div>
    </template>
  </ModalDialog>
</template>
