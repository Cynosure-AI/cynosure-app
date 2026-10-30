<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { Icon } from '@iconify/vue'
import type { MemoryFolder } from '../../api/types'
import {
  OPT_IN_MEMORY_FOLDER_HINT,
  allMemoryDescription,
  allMemoryFolderSelectionIds,
  effectiveMemoryFolders,
  isAutoExcludedMemoryFolder,
  memoryFolderSelectionInfo,
  toggleMemoryFolderSelection,
  type MemoryFolderSelectionInfo,
} from '../../utils/memory-folder-selection'

const props = withDefaults(
  defineProps<{
    folders: MemoryFolder[]
    /** Granted folder ids. A grant includes every subfolder. */
    modelValue: string[]
    /** External search query. When omitted the picker renders its own search field. */
    search?: string
    loading?: boolean
    /** Max height CSS class for the list; empty when the parent already scrolls. */
    maxHeight?: string
  }>(),
  {
    search: undefined,
    loading: false,
    maxHeight: 'max-h-96',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string[]]
}>()

const localSearch = ref('')
const collapsed = ref<Set<string>>(new Set())

const query = computed(() => (props.search ?? localSearch.value).toLowerCase().trim())

function pathParts(folder: MemoryFolder): string[] {
  return folder.isUncategorized ? [] : folder.folderPath.split('/').filter(Boolean)
}

function comparePaths(a: MemoryFolder, b: MemoryFolder): number {
  if (a.isUncategorized !== b.isUncategorized) return a.isUncategorized ? -1 : 1
  const left = pathParts(a)
  const right = pathParts(b)
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const order = left[i].localeCompare(right[i])
    if (order) return order
  }
  return left.length - right.length
}

const sortedFolders = computed(() => [...props.folders].sort(comparePaths))

const parentPaths = computed(() => {
  const paths = new Set<string>()
  for (const folder of props.folders) {
    const parts = pathParts(folder)
    for (let i = 1; i < parts.length; i++) paths.add(parts.slice(0, i).join('/'))
  }
  return paths
})

function hasChildren(folder: MemoryFolder): boolean {
  return !folder.isUncategorized && parentPaths.value.has(folder.folderPath)
}

/** Collapse every branch except those leading to a grant, so existing selections stay visible. */
function resetCollapsed(): void {
  const keepOpen = new Set<string>()
  const ids = new Set(props.modelValue)
  for (const folder of props.folders) {
    if (!ids.has(folder.id)) continue
    const parts = pathParts(folder)
    for (let i = 1; i < parts.length; i++) keepOpen.add(parts.slice(0, i).join('/'))
  }
  collapsed.value = new Set([...parentPaths.value].filter((path) => !keepOpen.has(path)))
}

watch(() => props.folders, resetCollapsed, { immediate: true })

const visibleFolders = computed(() => {
  if (query.value) {
    return sortedFolders.value.filter((folder) => {
      const text = folder.isUncategorized
        ? `all memory ${folder.name}`
        : `${folder.name} ${folder.description} ${folder.folderPath}`
      return text.toLowerCase().includes(query.value)
    })
  }
  return sortedFolders.value.filter((folder) => {
    const parts = pathParts(folder)
    for (let i = 1; i < parts.length; i++) {
      if (collapsed.value.has(parts.slice(0, i).join('/'))) return false
    }
    return true
  })
})

/** Track the final visible child at each level, including implicit parent paths. */
const treeGuides = computed(() => {
  const lastChild = new Map<string, string>()
  for (const folder of visibleFolders.value) {
    const parts = pathParts(folder)
    for (let level = 0; level < parts.length; level++) {
      lastChild.set(parts.slice(0, level).join('/'), parts.slice(0, level + 1).join('/'))
    }
  }
  return new Map(visibleFolders.value.map((folder) => {
    const parts = pathParts(folder)
    return [folder.id, parts.map((_, level) => ({
      branch: level === parts.length - 1,
      continues: lastChild.get(parts.slice(0, level).join('/')) !== parts.slice(0, level + 1).join('/'),
    }))]
  }))
})

const selectionInfo = computed(() => {
  const info = new Map<string, MemoryFolderSelectionInfo>()
  for (const folder of props.folders) info.set(folder.id, memoryFolderSelectionInfo(folder, props.folders, props.modelValue))
  return info
})

function infoFor(folder: MemoryFolder): MemoryFolderSelectionInfo {
  return selectionInfo.value.get(folder.id) ?? { state: 'none' }
}

const effectiveCount = computed(() => effectiveMemoryFolders(props.folders, props.modelValue).length)

function displayName(folder: MemoryFolder): string {
  return folder.isUncategorized ? 'All Memory' : folder.name
}

function docCount(folder: MemoryFolder): string {
  return `${folder.fileCount} doc${folder.fileCount === 1 ? '' : 's'}`
}

function detail(folder: MemoryFolder): string {
  if (folder.isUncategorized) return allMemoryDescription(props.folders)
  return query.value ? folder.folderPath : docCount(folder)
}

function rowTitle(folder: MemoryFolder): string | undefined {
  const info = infoFor(folder)
  if (info.state !== 'inherited' || !info.via) return undefined
  const via = displayName(info.via)
  return info.via.isUncategorized
    ? `Included via All Memory. Uncheck All Memory to choose folders individually, or make this folder opt-in in Memory.`
    : `Included via ${via}. A folder grant always includes its subfolders. Uncheck ${via} to choose them individually.`
}

function depth(folder: MemoryFolder): number {
  return folder.isUncategorized ? 0 : Math.max(1, pathParts(folder).length)
}

function toggle(folder: MemoryFolder): void {
  emit('update:modelValue', toggleMemoryFolderSelection(folder, props.folders, props.modelValue))
}

function toggleCollapsed(folder: MemoryFolder): void {
  const next = new Set(collapsed.value)
  if (next.has(folder.folderPath)) next.delete(folder.folderPath)
  else next.add(folder.folderPath)
  collapsed.value = next
}

function selectAll(): void {
  emit('update:modelValue', allMemoryFolderSelectionIds(props.folders))
}

function clearAll(): void {
  emit('update:modelValue', [])
}
</script>

<template>
  <div class="flex min-h-0 flex-col">
    <label
      v-if="search === undefined && folders.length > 0"
      class="mb-2 flex items-center gap-2 rounded-lg border border-theme-700 bg-theme-800 px-2.5 py-2 focus-within:border-accent-500"
    >
      <Icon
        icon="lucide:search"
        class="h-4 w-4 text-ink-muted"
      />
      <input
        v-model="localSearch"
        type="search"
        class="min-w-0 flex-1 bg-transparent text-xs text-theme-100 outline-none placeholder:text-ink-muted"
        placeholder="Search memory folders…"
        aria-label="Search memory folders"
      >
    </label>

    <div
      v-if="folders.length > 0"
      class="mb-1.5 flex items-center justify-between gap-2 px-1 text-xs"
    >
      <span class="text-ink-muted">
        {{ effectiveCount === folders.length ? 'All folders readable' : `${effectiveCount} of ${folders.length} folders readable` }}
      </span>
      <div class="flex items-center gap-3">
        <button
          v-if="effectiveCount < folders.length"
          type="button"
          class="text-accent-fg hover:underline"
          @click="selectAll"
        >
          Select all
        </button>
        <button
          v-if="modelValue.length > 0"
          type="button"
          class="text-ink-secondary hover:text-theme-200"
          @click="clearAll"
        >
          Clear
        </button>
      </div>
    </div>

    <div
      class="min-h-0 overflow-y-auto rounded-lg border border-theme-700"
      :class="maxHeight"
    >
      <div
        v-if="loading && folders.length === 0"
        class="py-6 text-center text-sm text-ink-muted"
      >
        <Icon
          icon="lucide:loader-2"
          class="mx-auto mb-2 h-4 w-4 animate-spin"
        />
        Loading folders…
      </div>
      <div
        v-else-if="folders.length === 0"
        class="py-6 text-center text-sm text-ink-muted"
      >
        No memory folders found
      </div>
      <div
        v-else-if="visibleFolders.length === 0"
        class="py-6 text-center text-sm text-ink-muted"
      >
        No folders match “{{ query }}”
      </div>
      <ul
        v-else
        aria-label="Memory folders"
      >
        <li
          v-for="folder in visibleFolders"
          :key="folder.id"
          class="flex items-center border-b border-theme-800 px-2 py-1.5 last:border-0 transition-colors"
          :class="infoFor(folder).state === 'selected'
            ? 'bg-accent-600/10'
            : infoFor(folder).state === 'inherited' ? 'bg-accent-600/5' : 'hover:bg-theme-800/60'"
          :title="rowTitle(folder)"
          :data-folder-id="folder.id"
          :data-state="infoFor(folder).state"
        >
          <span
            v-if="!query && depth(folder) > 0"
            :style="{ width: `${depth(folder) * 20}px` }"
            class="relative -my-1.5 flex shrink-0 self-stretch text-theme-500"
            aria-hidden="true"
          >
            <span
              v-for="(guide, level) in treeGuides.get(folder.id)"
              :key="level"
              class="relative w-5 shrink-0"
              :data-tree-guide="guide.branch ? (guide.continues ? 'tee' : 'elbow') : (guide.continues ? 'continuation' : 'empty')"
            >
              <span
                v-if="guide.branch || guide.continues"
                class="absolute left-1/2 top-0 border-l border-current"
                :class="guide.continues ? 'h-full' : 'h-1/2'"
              />
              <span
                v-if="guide.branch"
                class="absolute left-1/2 right-0 top-1/2 border-t border-current"
              />
            </span>
          </span>
          <button
            type="button"
            class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-muted transition-colors hover:text-theme-200"
            :class="{ 'invisible pointer-events-none': query || !hasChildren(folder) }"
            :aria-label="`${collapsed.has(folder.folderPath) ? 'Expand' : 'Collapse'} ${folder.name}`"
            :aria-expanded="hasChildren(folder) ? !collapsed.has(folder.folderPath) : undefined"
            :tabindex="query || !hasChildren(folder) ? -1 : 0"
            @click="toggleCollapsed(folder)"
          >
            <Icon
              icon="lucide:chevron-down"
              class="h-3.5 w-3.5 transition-transform"
              :class="{ '-rotate-90': collapsed.has(folder.folderPath) }"
            />
          </button>
          <label
            class="ml-1 flex min-w-0 flex-1 items-center gap-2 py-0.5"
            :class="infoFor(folder).state === 'inherited' ? 'cursor-default' : 'cursor-pointer'"
          >
            <input
              type="checkbox"
              class="h-4 w-4 shrink-0 accent-accent-500 disabled:opacity-60"
              :checked="infoFor(folder).state === 'selected' || infoFor(folder).state === 'inherited'"
              :indeterminate="infoFor(folder).state === 'partial'"
              :disabled="infoFor(folder).state === 'inherited'"
              @change="toggle(folder)"
            >
            <Icon
              :icon="folder.isUncategorized ? 'lucide:hard-drive' : 'lucide:folder'"
              class="h-4 w-4 shrink-0"
              :class="infoFor(folder).state === 'none' ? 'text-ink-muted' : 'text-accent-fg'"
            />
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1.5">
                <span class="truncate text-sm text-theme-200">{{ displayName(folder) }}</span>
                <span
                  v-if="!folder.isUncategorized && isAutoExcludedMemoryFolder(folder)"
                  class="shrink-0 rounded border border-theme-600 px-1 text-[10px] leading-4 text-ink-secondary"
                  :title="OPT_IN_MEMORY_FOLDER_HINT"
                >Opt-in</span>
              </span>
              <span class="block truncate text-[11px] text-ink-muted">{{ detail(folder) }}</span>
            </span>
          </label>
        </li>
      </ul>
    </div>
  </div>
</template>
