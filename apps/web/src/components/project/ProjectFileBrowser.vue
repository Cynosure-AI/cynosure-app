<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import { api } from '../../api/client'
import type { ProjectFileEntry } from '../../api/types'
import { formatBytes } from '../../utils/format-bytes'
import { documentTypeStyle, normalizeExtension } from '../../utils/document-types'
import DocumentTypeArt from '../shared/DocumentTypeArt.vue'

type BrowserLayout = 'list' | 'grid'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'])

/** Browse and search a project's directory. Folders open in place; files are handed to the parent. */
const props = defineProps<{
  projectId: string
  projectName?: string
  /** The project directory; when given, images and PDFs show thumbnails served through `/api/files`. */
  rootPath?: string
  defaultLayout?: BrowserLayout
  /** Files shown as picked. */
  selectedPaths?: ReadonlySet<string>
  /** Why a file can't be opened, shown in place of its size; files with a reason are disabled. */
  unavailableReason?: (entry: ProjectFileEntry) => string | null
}>()

const emit = defineEmits<{
  file: [entry: ProjectFileEntry]
}>()

const folder = ref('')
const entries = ref<ProjectFileEntry[]>([])
const truncated = ref(false)
const query = ref('')
const showHidden = ref(false)
const loading = ref(false)
const layout = ref<BrowserLayout>(props.defaultLayout ?? 'list')
/** Thumbnails that failed to load fall back to the file-type icon. */
const brokenThumbnails = ref(new Set<string>())
const error = ref('')
let searchTimer: ReturnType<typeof setTimeout> | null = null
let requestSequence = 0

const breadcrumbs = computed(() => {
  const parts = folder.value ? folder.value.split('/') : []
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }))
})
const searching = computed(() => Boolean(query.value.trim()))

function isSelected(entry: ProjectFileEntry): boolean {
  return Boolean(props.selectedPaths?.has(entry.path))
}

function extension(entry: ProjectFileEntry): string {
  const dot = entry.name.lastIndexOf('.')
  return dot > 0 ? normalizeExtension(entry.name.slice(dot)) : ''
}

/** `/api/files` href for a project file, built from the project directory's absolute path. */
function fileHref(entry: ProjectFileEntry): string | undefined {
  if (!props.rootPath) return undefined
  const separator = props.rootPath.includes('\\') && !props.rootPath.includes('/') ? '\\' : '/'
  const absolute = `${props.rootPath.replace(/[\\/]+$/, '')}${separator}${entry.path.split('/').join(separator)}`
  return `/api/files?path=${encodeURIComponent(absolute)}`
}

function thumbnail(entry: ProjectFileEntry): string | undefined {
  if (entry.type !== 'file' || !IMAGE_EXTENSIONS.has(extension(entry)) || brokenThumbnails.value.has(entry.path)) return undefined
  return fileHref(entry)
}

function markBroken(entry: ProjectFileEntry): void {
  brokenThumbnails.value = new Set(brokenThumbnails.value).add(entry.path)
}

function sizeLabel(entry: ProjectFileEntry): string {
  return reason(entry) ?? (entry.size === undefined ? '' : formatBytes(entry.size))
}

function reason(entry: ProjectFileEntry): string | null {
  return entry.type === 'file' ? props.unavailableReason?.(entry) ?? null : null
}

async function load(path = folder.value): Promise<void> {
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
  if (!reason(entry)) emit('file', entry)
}

watch(query, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void load(), 250)
})

watch(showHidden, () => void load())

watch(() => props.projectId, () => {
  query.value = ''
  entries.value = []
  void load('')
})

onMounted(() => void load(''))
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

defineExpose({ reload: () => load() })
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex shrink-0 items-center gap-2">
      <label class="relative block min-w-0 flex-1">
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
      <div
        role="group"
        aria-label="Layout"
        class="flex shrink-0 items-center gap-0.5 rounded-lg border border-theme-700 bg-theme-900/60 p-0.5"
      >
        <button
          v-for="mode in ([
            { value: 'list', label: 'List view', icon: 'lucide:list' },
            { value: 'grid', label: 'Grid view', icon: 'lucide:grid-2x2' },
          ] as const)"
          :key="mode.value"
          type="button"
          :title="mode.label"
          :aria-label="mode.label"
          :aria-pressed="layout === mode.value"
          class="flex h-8 w-8 items-center justify-center rounded-md transition"
          :class="layout === mode.value
            ? 'bg-theme-700 text-theme-100 shadow-sm'
            : 'text-ink-muted hover:bg-theme-800/70 hover:text-theme-200'"
          @click="layout = mode.value"
        >
          <Icon
            :icon="mode.icon"
            class="h-3.5 w-3.5"
          />
        </button>
      </div>
    </div>

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

    <div class="flex min-h-40 flex-1 flex-col overflow-y-auto rounded-lg border border-theme-800">
      <div
        v-if="loading && !entries.length"
        class="flex flex-1 items-center justify-center text-sm text-ink-muted"
      >
        <Icon
          icon="lucide:loader-circle"
          class="mr-2 h-4 w-4 animate-spin"
        /> Loading files…
      </div>
      <div
        v-else-if="!entries.length"
        class="flex flex-1 flex-col items-center justify-center text-center text-sm text-ink-muted"
      >
        <Icon
          :icon="searching ? 'lucide:search-x' : 'lucide:folder-x'"
          class="mb-3 h-9 w-9"
        />
        {{ searching ? 'No matching files' : 'This folder is empty' }}
      </div>
      <ul
        v-else-if="layout === 'list'"
        class="divide-y divide-theme-800"
        :class="{ 'opacity-60': loading }"
      >
        <li
          v-for="entry in entries"
          :key="entry.path"
        >
          <button
            type="button"
            class="flex w-full items-center gap-3 px-4 py-1.5 text-left text-sm hover:bg-theme-800 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
            :class="isSelected(entry) ? 'bg-accent-500/10 text-theme-100' : 'text-theme-200'"
            :disabled="Boolean(reason(entry))"
            :aria-pressed="selectedPaths && entry.type === 'file' ? isSelected(entry) : undefined"
            @click="open(entry)"
          >
            <span class="relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md">
              <img
                v-if="thumbnail(entry)"
                :src="thumbnail(entry)"
                alt=""
                loading="lazy"
                class="h-full w-full bg-theme-950 object-cover"
                @error="markBroken(entry)"
              >
              <Icon
                v-else
                :icon="entry.type === 'directory' ? 'lucide:folder' : documentTypeStyle(extension(entry)).icon"
                class="h-5 w-5"
                :class="entry.type === 'directory' ? 'text-accent-fg' : documentTypeStyle(extension(entry)).text"
              />
              <span
                v-if="isSelected(entry)"
                class="absolute inset-0 flex items-center justify-center bg-accent-500/70 text-accent-on"
              >
                <Icon
                  icon="lucide:check"
                  class="h-4 w-4"
                />
              </span>
            </span>
            <span class="min-w-0 flex-1 truncate">{{ searching ? entry.path : entry.name }}</span>
            <span
              v-if="entry.type === 'file'"
              class="shrink-0 text-[11px]"
              :class="reason(entry) ? 'text-ink-secondary' : 'text-ink-faint'"
            >{{ sizeLabel(entry) }}</span>
            <Icon
              v-else
              icon="lucide:chevron-right"
              class="h-4 w-4 shrink-0 text-ink-faint"
            />
          </button>
        </li>
      </ul>
      <ul
        v-else
        class="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-3 p-3"
        :class="{ 'opacity-60': loading }"
      >
        <li
          v-for="entry in entries"
          :key="entry.path"
        >
          <button
            type="button"
            class="group w-full overflow-hidden rounded-xl border bg-theme-950/45 text-left transition hover:border-theme-600 disabled:cursor-default disabled:opacity-50 disabled:hover:border-theme-800"
            :class="isSelected(entry) ? 'border-accent-500 ring-1 ring-accent-500' : 'border-theme-800'"
            :disabled="Boolean(reason(entry))"
            :aria-pressed="selectedPaths && entry.type === 'file' ? isSelected(entry) : undefined"
            :title="entry.path"
            @click="open(entry)"
          >
            <span class="relative flex aspect-4/3 w-full items-center justify-center overflow-hidden bg-theme-950">
              <img
                v-if="thumbnail(entry)"
                :src="thumbnail(entry)"
                alt=""
                loading="lazy"
                class="h-full w-full object-cover transition duration-300 group-hover:scale-[1.025]"
                @error="markBroken(entry)"
              >
              <Icon
                v-else-if="entry.type === 'directory'"
                icon="lucide:folder"
                class="h-12 w-12 text-accent-fg transition duration-300 group-hover:scale-[1.05]"
              />
              <DocumentTypeArt
                v-else
                :ext="extension(entry)"
                :href="fileHref(entry)"
                compact
                class="transition duration-300 group-hover:scale-[1.025]"
              />
              <span
                v-if="isSelected(entry)"
                class="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-accent-500 text-accent-on shadow"
              >
                <Icon
                  icon="lucide:check"
                  class="h-3.5 w-3.5"
                />
              </span>
            </span>
            <span class="block px-2 py-1.5">
              <span class="block truncate text-xs text-theme-200">{{ searching ? entry.path : entry.name }}</span>
              <span
                class="block truncate text-[10px]"
                :class="reason(entry) ? 'text-ink-secondary' : 'text-ink-faint'"
              >{{ entry.type === 'directory' ? 'Folder' : sizeLabel(entry) }}</span>
            </span>
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
</template>
