<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import { api } from '../../../api/client'
import type { MemoryFileSearchResult, MemoryFolder, ProjectFileContent } from '../../../api/types'
import ModalDialog from '../../shared/ModalDialog.vue'
import { documentTypeStyle } from '../../../utils/document-types'
import { formatBytes } from '../../../utils/format-bytes'
import { formatRelativeTime } from '../../../utils/project-format'

/** Mirrors the server cap so oversized files can't be picked. */
const MAX_FILE_BYTES = 20 * 1024 * 1024
const RECENT_LIMIT = 40

const props = defineProps<{
  show: boolean
  folders: MemoryFolder[]
  /** Source ids already in the draft. */
  alreadySelectedIds?: string[]
}>()

const emit = defineEmits<{
  close: []
  add: [files: Array<ProjectFileContent & { sourceId: string }>]
}>()

const query = ref('')
const folderId = ref('')
const searchContents = ref(false)
const results = ref<MemoryFileSearchResult[]>([])
const selected = ref(new Map<string, MemoryFileSearchResult>())
const loading = ref(false)
const adding = ref(false)
const error = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
let searchTimer: ReturnType<typeof setTimeout> | null = null
let requestSequence = 0

const unavailableIds = computed(() => new Set(props.alreadySelectedIds || []))
const folderOptions = computed(() => props.folders.filter(folder => !folder.isUncategorized))
const isSearching = computed(() => Boolean(query.value.trim()))

/** The composer source id; lets the draft skip files it already holds. */
function memorySourceId(file: Pick<MemoryFileSearchResult, 'folderId' | 'fileName'>): string {
  return `memory:${file.folderId}/${file.fileName}`
}

function unavailableReason(file: MemoryFileSearchResult): string | null {
  if (unavailableIds.value.has(memorySourceId(file))) return 'Already attached'
  return file.size > MAX_FILE_BYTES ? 'Over 20 MB' : null
}

function statusLabel(file: MemoryFileSearchResult): string | null {
  if (file.status === 'needs_reindex') return 'Changed since indexing'
  if (file.status === 'not_indexed') return 'Not indexed'
  return null
}

async function load(): Promise<void> {
  const sequence = ++requestSequence
  loading.value = true
  error.value = ''
  try {
    const trimmed = query.value.trim()
    const scope = folderId.value || undefined
    const response = trimmed
      ? await api.memoryFolders.searchFiles(trimmed, { folderId: scope, semantic: searchContents.value })
      : await api.memoryFolders.listRecentFiles({ folderId: scope, limit: RECENT_LIMIT })
    if (sequence !== requestSequence) return
    results.value = response
  } catch (err) {
    if (sequence !== requestSequence) return
    results.value = []
    error.value = err instanceof Error ? err.message : 'Could not load memories'
  } finally {
    if (sequence === requestSequence) loading.value = false
  }
}

function scheduleLoad(): void {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void load(), searchContents.value ? 400 : 200)
}

function toggle(file: MemoryFileSearchResult): void {
  if (unavailableReason(file)) return
  const key = memorySourceId(file)
  const next = new Map(selected.value)
  if (next.has(key)) next.delete(key)
  else next.set(key, file)
  selected.value = next
}

async function addSelected(): Promise<void> {
  if (!selected.value.size || adding.value) return
  adding.value = true
  error.value = ''
  try {
    const picks = [...selected.value.values()]
    const settled = await Promise.allSettled(picks.map(file => api.memoryFolders.readAttachment(file.folderId, file.fileName)))
    const files = settled.flatMap((result, index) => result.status === 'fulfilled'
      ? [{ ...result.value, sourceId: memorySourceId(picks[index]!) }]
      : [])
    const failures = settled.flatMap((result, index) => result.status === 'rejected'
      ? [`${picks[index]!.fileName}: ${result.reason instanceof Error ? result.reason.message : 'Could not read the file'}`]
      : [])
    if (files.length) emit('add', files)
    if (!failures.length) {
      emit('close')
      return
    }
    // Keep only the files that failed so the user can see what was skipped.
    const added = new Set(files.map(file => file.sourceId))
    selected.value = new Map([...selected.value].filter(([key]) => !added.has(key)))
    error.value = failures.join('\n')
  } finally {
    adding.value = false
  }
}

watch(() => props.show, async (show) => {
  if (!show) return
  query.value = ''
  folderId.value = ''
  searchContents.value = false
  selected.value = new Map()
  results.value = []
  void load()
  await nextTick()
  searchInput.value?.focus()
})

watch(query, () => { if (props.show) scheduleLoad() })
watch([folderId, searchContents], () => { if (props.show) void load() })
</script>

<template>
  <ModalDialog
    :show="show"
    title="Attach From Memories"
    icon="lucide:brain"
    max-width="max-w-2xl"
    max-height="max-h-[82vh]"
    @close="emit('close')"
  >
    <div class="flex h-[min(62vh,600px)] min-h-80 flex-col gap-3">
      <div class="flex shrink-0 flex-wrap items-center gap-2">
        <label class="relative min-w-48 flex-1">
          <span class="sr-only">Search memory files</span>
          <Icon
            icon="lucide:search"
            class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
          />
          <input
            ref="searchInput"
            v-model="query"
            type="search"
            :placeholder="searchContents ? 'Describe what the document is about…' : 'Search by file or folder name…'"
            class="w-full rounded-lg border border-theme-700 bg-theme-800 py-2.5 pl-9 pr-3 text-sm text-theme-100 outline-none placeholder:text-ink-muted focus:border-accent-500"
            @keydown.ctrl.enter.prevent="addSelected"
            @keydown.meta.enter.prevent="addSelected"
          >
        </label>
        <label class="shrink-0">
          <span class="sr-only">Memory folder</span>
          <select
            v-model="folderId"
            class="max-w-48 rounded-lg border border-theme-700 bg-theme-800 px-2.5 py-2.5 text-sm text-theme-100 outline-none focus:border-accent-500"
          >
            <option value="">
              All memories
            </option>
            <option
              v-for="folder in folderOptions"
              :key="folder.id"
              :value="folder.id"
            >
              {{ '  '.repeat(folder.depth ?? 0) }}{{ folder.name }}
            </option>
          </select>
        </label>
        <button
          type="button"
          role="switch"
          :aria-checked="searchContents"
          class="flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-2.5 text-sm transition-colors"
          :class="searchContents ? 'border-accent-500 bg-accent-500/10 text-accent-fg' : 'border-theme-700 bg-theme-800 text-theme-300 hover:border-theme-600'"
          title="Search inside indexed documents by meaning instead of by name"
          @click="searchContents = !searchContents"
        >
          <Icon
            icon="lucide:sparkles"
            class="h-4 w-4"
          />
          Contents
        </button>
      </div>

      <div
        v-if="error"
        role="alert"
        class="shrink-0 whitespace-pre-line rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
      >
        {{ error }}
      </div>

      <p class="shrink-0 px-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
        {{ isSearching ? (searchContents ? 'Best matches' : 'Results') : 'Recently changed' }}
      </p>

      <div class="min-h-0 flex-1 overflow-y-auto pr-1">
        <div
          v-if="loading && !results.length"
          class="flex h-full items-center justify-center text-sm text-ink-muted"
        >
          <Icon
            icon="lucide:loader-circle"
            class="mr-2 h-4 w-4 animate-spin"
          /> {{ isSearching ? 'Searching…' : 'Loading memories…' }}
        </div>
        <div
          v-else-if="!results.length"
          class="flex h-full flex-col items-center justify-center text-center text-ink-muted"
        >
          <Icon
            :icon="isSearching ? 'lucide:search-x' : 'lucide:brain'"
            class="mb-3 h-9 w-9"
          />
          <p class="text-sm text-theme-300">
            {{ isSearching ? 'No matching memory files' : 'No memory files yet' }}
          </p>
          <p
            v-if="isSearching && !searchContents"
            class="mt-1 text-xs"
          >
            Try “Contents” to search inside documents.
          </p>
        </div>
        <ul
          v-else
          class="flex flex-col gap-1"
          aria-label="Memory files"
        >
          <li
            v-for="file in results"
            :key="memorySourceId(file)"
          >
            <button
              type="button"
              class="flex w-full min-w-0 items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors"
              :class="[
                selected.has(memorySourceId(file)) ? 'border-accent-500 bg-accent-500/10' : 'border-transparent hover:bg-theme-800',
                unavailableReason(file) ? 'cursor-default opacity-50' : '',
              ]"
              :disabled="Boolean(unavailableReason(file))"
              :aria-pressed="selected.has(memorySourceId(file))"
              :title="unavailableReason(file) || `${file.folderPath || file.folderName}/${file.fileName}`"
              @click="toggle(file)"
            >
              <span
                class="flex h-4 w-4 shrink-0 items-center justify-center rounded border"
                :class="selected.has(memorySourceId(file)) ? 'border-accent-500 accent-action bg-accent-500 text-accent-on' : 'border-theme-600 bg-theme-950'"
              >
                <Icon
                  v-if="selected.has(memorySourceId(file))"
                  icon="lucide:check"
                  class="h-3 w-3"
                />
              </span>
              <Icon
                :icon="documentTypeStyle(file.extension).icon"
                class="h-5 w-5 shrink-0"
                :class="documentTypeStyle(file.extension).text"
              />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm text-theme-100">{{ file.fileName }}</span>
                <span class="flex min-w-0 items-center gap-1 text-[11px] text-ink-muted">
                  <Icon
                    icon="lucide:folder"
                    class="h-3 w-3 shrink-0"
                  />
                  <span class="truncate">{{ file.folderPath || file.folderName }}</span>
                  <span class="shrink-0">· {{ formatRelativeTime(file.modifiedAt) }} · {{ formatBytes(file.size) }}</span>
                </span>
              </span>
              <span
                v-if="file.similarity !== undefined"
                class="shrink-0 text-[11px] tabular-nums text-ink-muted"
              >{{ Math.round(file.similarity * 100) }}%</span>
              <span
                v-if="unavailableReason(file)"
                class="shrink-0 text-[11px] text-ink-muted"
              >{{ unavailableReason(file) }}</span>
              <span
                v-else-if="statusLabel(file)"
                class="shrink-0 rounded-full bg-theme-800 px-2 py-0.5 text-[10px] text-ink-muted"
              >{{ statusLabel(file) }}</span>
            </button>
          </li>
        </ul>
      </div>
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
