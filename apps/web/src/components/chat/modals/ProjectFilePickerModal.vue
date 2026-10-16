<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import { api } from '../../../api/client'
import type { ProjectFileContent, ProjectFileEntry } from '../../../api/types'
import ModalDialog from '../../shared/ModalDialog.vue'

/** Mirrors the server cap so oversized files can't be picked. */
const MAX_FILE_BYTES = 20 * 1024 * 1024

const props = defineProps<{
  show: boolean
  projectId: string | null
  projectName?: string
  /** Project-relative paths already in the draft. */
  alreadySelectedPaths?: string[]
}>()

const emit = defineEmits<{
  close: []
  add: [files: ProjectFileContent[]]
}>()

const folder = ref('')
const entries = ref<ProjectFileEntry[]>([])
const truncated = ref(false)
const query = ref('')
const showHidden = ref(false)
const selected = ref(new Map<string, ProjectFileEntry>())
const loading = ref(false)
const adding = ref(false)
const error = ref('')
let searchTimer: ReturnType<typeof setTimeout> | null = null
let requestSequence = 0

const breadcrumbs = computed(() => {
  const parts = folder.value ? folder.value.split('/') : []
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }))
})
const unavailablePaths = computed(() => new Set(props.alreadySelectedPaths || []))
const searching = computed(() => Boolean(query.value.trim()))

function formatSize(bytes?: number): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function unavailable(entry: ProjectFileEntry): boolean {
  return unavailablePaths.value.has(entry.path) || (entry.size ?? 0) > MAX_FILE_BYTES
}

async function load(path = folder.value): Promise<void> {
  if (!props.projectId) return
  const sequence = ++requestSequence
  loading.value = true
  error.value = ''
  try {
    const listing = await api.projects.listFiles(props.projectId, { path, query: query.value, showHidden: showHidden.value })
    if (sequence !== requestSequence) return
    if (!searching.value) folder.value = listing.path
    entries.value = listing.entries
    truncated.value = Boolean(listing.truncated)
  } catch (err) {
    if (sequence === requestSequence) error.value = err instanceof Error ? err.message : 'Could not list project files'
  } finally {
    if (sequence === requestSequence) loading.value = false
  }
}

function open(entry: ProjectFileEntry): void {
  if (entry.type === 'directory') {
    query.value = ''
    void load(entry.path)
    return
  }
  if (unavailable(entry)) return
  const next = new Map(selected.value)
  if (next.has(entry.path)) next.delete(entry.path)
  else next.set(entry.path, entry)
  selected.value = next
}

async function addSelected(): Promise<void> {
  if (!props.projectId || !selected.value.size || adding.value) return
  adding.value = true
  error.value = ''
  const projectId = props.projectId
  try {
    const paths = [...selected.value.keys()]
    const results = await Promise.allSettled(paths.map(path => api.projects.readFile(projectId, path)))
    const files = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    const failures = results.flatMap((result, index) => result.status === 'rejected'
      ? [`${paths[index]}: ${result.reason instanceof Error ? result.reason.message : 'Could not read the file'}`]
      : [])
    if (files.length) emit('add', files)
    if (!failures.length) {
      emit('close')
      return
    }
    // Keep only the files that failed so the user can see what was skipped.
    selected.value = new Map([...selected.value].filter(([path]) => !files.some(file => file.name === path)))
    error.value = failures.join('\n')
  } finally {
    adding.value = false
  }
}

watch(() => props.show, (show) => {
  if (!show) return
  folder.value = ''
  query.value = ''
  selected.value = new Map()
  entries.value = []
  void load('')
})

watch(query, () => {
  if (!props.show) return
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void load(), 250)
})

watch(showHidden, () => {
  if (props.show) void load()
})
</script>

<template>
  <ModalDialog
    :show="show"
    :title="projectName ? `Attach From ${projectName}` : 'Attach From Project'"
    icon="lucide:folder-open"
    max-width="max-w-2xl"
    max-height="max-h-[82vh]"
    @close="emit('close')"
  >
    <div class="flex h-[min(62vh,600px)] min-h-80 flex-col gap-3">
      <label class="relative block shrink-0">
        <span class="sr-only">Search project files</span>
        <Icon
          icon="lucide:search"
          class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
        />
        <input
          v-model="query"
          type="search"
          placeholder="Search files by path…"
          class="w-full rounded-lg border border-theme-700 bg-theme-800 py-2.5 pl-9 pr-3 text-sm text-theme-100 outline-none placeholder:text-ink-muted focus:border-accent-500"
        >
      </label>

      <nav
        v-if="!searching"
        aria-label="Project folder"
        class="flex min-w-0 shrink-0 flex-wrap items-center gap-1 text-xs text-ink-muted"
      >
        <button
          type="button"
          class="rounded px-1.5 py-0.5 hover:bg-theme-800 hover:text-theme-100"
          :class="!folder ? 'text-theme-100' : ''"
          @click="load('')"
        >
          {{ projectName || 'Project' }}
        </button>
        <template
          v-for="crumb in breadcrumbs"
          :key="crumb.path"
        >
          <Icon
            icon="lucide:chevron-right"
            class="h-3 w-3 shrink-0"
          />
          <button
            type="button"
            class="max-w-48 truncate rounded px-1.5 py-0.5 hover:bg-theme-800 hover:text-theme-100"
            :class="crumb.path === folder ? 'text-theme-100' : ''"
            @click="load(crumb.path)"
          >
            {{ crumb.name }}
          </button>
        </template>
      </nav>

      <div
        v-if="error"
        role="alert"
        class="flex items-start gap-2 whitespace-pre-line rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
      >
        <Icon
          icon="lucide:circle-alert"
          class="mt-0.5 h-4 w-4 shrink-0"
        />
        <span>{{ error }}</span>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto rounded-lg border border-theme-800">
        <div
          v-if="loading && !entries.length"
          class="flex h-full items-center justify-center text-sm text-ink-muted"
        >
          <Icon
            icon="lucide:loader-circle"
            class="mr-2 h-4 w-4 animate-spin"
          /> Loading files…
        </div>
        <div
          v-else-if="!entries.length"
          class="flex h-full flex-col items-center justify-center text-center text-sm text-ink-muted"
        >
          <Icon
            :icon="searching ? 'lucide:search-x' : 'lucide:folder-x'"
            class="mb-3 h-9 w-9"
          />
          {{ searching ? 'No matching files' : 'This folder is empty' }}
        </div>
        <ul
          v-else
          class="divide-y divide-theme-800"
          :class="{ 'opacity-60': loading }"
        >
          <li
            v-for="entry in entries"
            :key="entry.path"
          >
            <button
              type="button"
              class="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-theme-800 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
              :class="selected.has(entry.path) ? 'bg-accent-500/10 text-theme-100' : 'text-theme-200'"
              :disabled="entry.type === 'file' && unavailable(entry)"
              :aria-pressed="entry.type === 'file' ? selected.has(entry.path) : undefined"
              @click="open(entry)"
            >
              <Icon
                :icon="entry.type === 'directory' ? 'lucide:folder' : selected.has(entry.path) ? 'lucide:circle-check' : 'lucide:file'"
                class="h-4 w-4 shrink-0"
                :class="entry.type === 'directory' || selected.has(entry.path) ? 'text-accent-fg' : 'text-ink-secondary'"
              />
              <span class="min-w-0 flex-1 truncate">{{ searching ? entry.path : entry.name }}</span>
              <span
                v-if="unavailablePaths.has(entry.path)"
                class="shrink-0 text-[11px] text-ink-secondary"
              >Already attached</span>
              <span
                v-else-if="entry.type === 'file'"
                class="shrink-0 text-[11px] text-ink-faint"
              >{{ (entry.size ?? 0) > MAX_FILE_BYTES ? 'Over 20 MB' : formatSize(entry.size) }}</span>
              <Icon
                v-else
                icon="lucide:chevron-right"
                class="h-4 w-4 shrink-0 text-ink-faint"
              />
            </button>
          </li>
        </ul>
        <p
          v-if="searching && truncated"
          class="px-4 py-2 text-[11px] text-ink-muted"
        >
          Showing the first matches. Refine the search to narrow them down.
        </p>
      </div>

      <label class="flex shrink-0 items-center gap-2 text-xs text-ink-muted">
        <input
          v-model="showHidden"
          type="checkbox"
          class="accent-accent-500"
        >
        Show hidden files
      </label>
    </div>

    <template #actions>
      <div class="flex items-center justify-end gap-2">
        <span
          v-if="selected.size"
          class="mr-auto text-xs text-ink-muted"
        >{{ selected.size }} selected</span>
        <button
          type="button"
          class="rounded-lg border border-theme-700 px-4 py-2 text-sm text-theme-300 hover:bg-theme-800"
          @click="emit('close')"
        >
          Cancel
        </button>
        <button
          type="button"
          :disabled="!selected.size || adding"
          class="rounded-lg accent-action bg-accent-600 px-4 py-2 text-sm font-medium text-accent-on disabled:opacity-50"
          @click="addSelected"
        >
          {{ adding ? 'Attaching…' : selected.size > 1 ? `Attach ${selected.size} files` : 'Attach' }}
        </button>
      </div>
    </template>
  </ModalDialog>
</template>
