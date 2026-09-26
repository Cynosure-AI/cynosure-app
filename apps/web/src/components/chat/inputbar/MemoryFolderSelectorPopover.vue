<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CSSProperties } from 'vue'
import { onClickOutside } from '@vueuse/core'
import { Icon } from '@iconify/vue'
import type { MemoryFolder } from '../../../api/types'
import { useChatStore } from '../../../stores/chat.store'
import { allMemoryFolderSelectionIds, isAutoExcludedMemoryFolder, isMemoryFolderSelected } from '../../../utils/memory-folder-selection'
import ToggleSwitch from '../../shared/ToggleSwitch.vue'

const chatStore = useChatStore()

const root = ref<HTMLElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const open = ref(false)
const loading = ref(false)
const search = ref('')
const folderPathStack = ref<string[]>([])
const menuStyle = ref<CSSProperties>({})

const folders = computed(() => chatStore.memoryFolders)
const selected = computed(() => chatStore.freeChatMemoryFolderIds)
const selectedSet = computed(() => new Set(selected.value))
const rootFolder = computed(() => folders.value.find((folder) => folder.isUncategorized))
const rootSelected = computed(() => Boolean(rootFolder.value && selectedSet.value.has(rootFolder.value.id)))
const allSelected = computed(() => folders.value.length > 0 && folders.value.every(isSelected))
const selectedCount = computed(() => folders.value.filter(isSelected).length)
const activeFolderPath = computed(() => folderPathStack.value.at(-1) ?? null)
const activeFolder = computed(() => folders.value.find((folder) => folder.folderPath === activeFolderPath.value) ?? null)

const visibleFolders = computed(() => {
  const query = search.value.trim().toLowerCase()
  if (query && !activeFolderPath.value) {
    return folders.value.filter((folder) =>
      folderLabel(folder).toLowerCase().includes(query)
      || folder.description.toLowerCase().includes(query)
      || folder.folderPath.toLowerCase().includes(query),
    )
  }

  return folders.value.filter((folder) => {
    if (!activeFolderPath.value) return folder.isUncategorized || parentPath(folder) === null
    return !folder.isUncategorized && parentPath(folder) === activeFolderPath.value
  })
})

function folderLabel(folder: MemoryFolder): string {
  return folder.isUncategorized ? 'All Memory' : folder.name
}

function parentPath(folder: MemoryFolder): string | null {
  if (folder.isUncategorized) return null
  if (folder.parentFolderPath !== undefined) return folder.parentFolderPath || null
  const parts = folder.folderPath.split('/').filter(Boolean)
  return parts.length > 1 ? parts.slice(0, -1).join('/') : null
}

function hasChildren(folder: MemoryFolder): boolean {
  if (folder.isUncategorized) return false
  return folders.value.some((candidate) => !candidate.isUncategorized && parentPath(candidate) === folder.folderPath)
}

function isSelected(folder: MemoryFolder): boolean {
  return isMemoryFolderSelected(folder, selectedSet.value, rootSelected.value)
}

function isPartiallySelected(folder: MemoryFolder): boolean {
  if (folder.isUncategorized) {
    return !rootSelected.value && folders.value.some((candidate) => !candidate.isUncategorized && isSelected(candidate))
  }
  if (!hasChildren(folder) || selectedSet.value.has(folder.id)) return false
  const prefix = `${folder.folderPath}/`
  return folders.value.some((candidate) => candidate.folderPath.startsWith(prefix) && selectedSet.value.has(candidate.id))
}

function folderScopeIds(folder: MemoryFolder): string[] {
  if (folder.isUncategorized) return [folder.id]
  const prefix = `${folder.folderPath}/`
  return folders.value
    .filter((candidate) => candidate.id === folder.id || candidate.folderPath.startsWith(prefix))
    .map((candidate) => candidate.id)
}

function toggleFolder(folder: MemoryFolder): void {
  const current = new Set(selected.value)
  const scopedIds = folderScopeIds(folder)

  if (folder.isUncategorized) {
    current.clear()
    if (!rootSelected.value) current.add(folder.id)
  } else if (rootSelected.value && isAutoExcludedMemoryFolder(folder)) {
    if (current.has(folder.id)) scopedIds.forEach((id) => current.delete(id))
    else scopedIds.forEach((id) => current.add(id))
  } else if (rootSelected.value) {
    const excludedIds = new Set(scopedIds)
    const previouslySelectedIds = folders.value
      .filter((candidate) => !candidate.isUncategorized && isSelected(candidate) && !excludedIds.has(candidate.id))
      .map((candidate) => candidate.id)
    current.clear()
    previouslySelectedIds.forEach((id) => current.add(id))
  } else if (current.has(folder.id)) {
    scopedIds.forEach((id) => current.delete(id))
  } else {
    scopedIds.forEach((id) => current.add(id))
  }

  chatStore.freeChatMemoryFolderIds.splice(0, selected.value.length, ...current)
  markSelectionChanged()
}

function openFolder(folder: MemoryFolder): void {
  if (!hasChildren(folder)) return
  folderPathStack.value = [...folderPathStack.value, folder.folderPath]
}

function showParentFolder(): void {
  folderPathStack.value = folderPathStack.value.slice(0, -1)
}

function selectAll(): void {
  const ids = allMemoryFolderSelectionIds(folders.value)
  chatStore.freeChatMemoryFolderIds.splice(0, selected.value.length, ...ids)
  markSelectionChanged()
}

function deselectAll(): void {
  chatStore.freeChatMemoryFolderIds.splice(0, selected.value.length)
  markSelectionChanged()
}

function markSelectionChanged(): void {
  chatStore.freeChatMemorySelectionInitialized = true
  chatStore.markOverridesModified()
}

function setAutoMemory(enabled: boolean): void {
  chatStore.sessionAutoMemory = enabled
  markSelectionChanged()
}

async function refreshFolders(): Promise<void> {
  loading.value = true
  try {
    await chatStore.loadMemoryFolders()
    const validIds = new Set(folders.value.map((folder) => folder.id))
    const validSelection = selected.value.filter((id) => validIds.has(id))
    if (validSelection.length !== selected.value.length) {
      chatStore.freeChatMemoryFolderIds.splice(0, selected.value.length, ...validSelection)
      markSelectionChanged()
    }
  } finally {
    loading.value = false
  }
}

function updatePosition(): void {
  const rect = root.value?.getBoundingClientRect()
  if (!rect) return
  const padding = 8
  const gap = 8
  const preferredHeight = 512
  const width = Math.min(320, window.innerWidth - padding * 2)
  const availableAbove = Math.max(0, rect.top - gap - padding)
  const availableBelow = Math.max(0, window.innerHeight - rect.bottom - gap - padding)
  const openAbove = availableAbove >= Math.min(280, preferredHeight) || availableAbove >= availableBelow
  const availableHeight = openAbove ? availableAbove : availableBelow
  const position = openAbove
    ? { bottom: `${window.innerHeight - rect.top + gap}px` }
    : { top: `${rect.bottom + gap}px` }

  menuStyle.value = {
    width: `${width}px`,
    left: `${Math.min(Math.max(rect.left, padding), window.innerWidth - width - padding)}px`,
    maxHeight: `${Math.min(preferredHeight, availableHeight)}px`,
    ...position,
  }
}

function close(): void {
  open.value = false
  search.value = ''
  folderPathStack.value = []
}

async function toggle(): Promise<void> {
  open.value = !open.value
  if (!open.value) {
    close()
    return
  }
  await nextTick()
  updatePosition()
}

function handleEscape(): void {
  if (activeFolderPath.value) showParentFolder()
  else close()
}

onClickOutside(root, close, { ignore: [menu] })

watch(open, (isOpen) => {
  if (isOpen) void refreshFolders()
})

watch(folders, () => {
  if (activeFolderPath.value && !activeFolder.value) folderPathStack.value = []
})

onMounted(() => {
  window.addEventListener('resize', updatePosition)
  window.addEventListener('scroll', updatePosition, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updatePosition)
  window.removeEventListener('scroll', updatePosition, true)
})
</script>

<template>
  <span
    ref="root"
    class="inline-flex"
  >
    <slot
      name="trigger"
      :open="open"
      :toggle="toggle"
      :close="close"
    />
  </span>

  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-100 ease-out"
      leave-active-class="transition duration-75 ease-in"
      enter-from-class="translate-y-1 opacity-0"
      leave-to-class="translate-y-1 opacity-0"
    >
      <div
        v-if="open"
        ref="menu"
        class="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-theme-700 bg-theme-900 shadow-2xl shadow-black/40"
        :style="menuStyle"
        role="menu"
        aria-label="Memory folders"
        @keydown.esc="handleEscape"
      >
        <div class="flex items-center gap-2 border-b border-theme-700 px-3 py-3">
          <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-500/10 text-accent-400">
            <Icon
              icon="lucide:database"
              class="h-4 w-4"
            />
          </span>
          <div class="min-w-0 flex-1">
            <div class="text-xs font-semibold text-theme-100">
              Auto Memories
            </div>
            <div class="text-[10px] text-theme-500">
              Automatically retrieve relevant memory context for this chat at turn-start. Decide which memory folders to include below.
            </div>
          </div>
          <ToggleSwitch
            :model-value="chatStore.sessionAutoMemory"
            label="Automatically retrieve relevant memory"
            size="sm"
            color="accent"
            @update:model-value="setAutoMemory"
          />
        </div>

        <template v-if="activeFolder">
          <button
            type="button"
            class="flex w-full items-center gap-2 border-b border-theme-800 px-3 py-2.5 text-left text-xs text-theme-300 hover:bg-theme-800 hover:text-theme-100"
            aria-label="Back to parent memory folder"
            @click="showParentFolder"
          >
            <Icon
              icon="lucide:chevron-left"
              class="h-4 w-4 shrink-0"
            />
            <span class="min-w-0 flex-1 truncate font-medium">{{ activeFolder.name }}</span>
            <span class="text-[10px] text-theme-600">{{ activeFolder.fileCount }} docs</span>
          </button>
        </template>
        <div
          v-else
          class="border-b border-theme-800 p-2"
        >
          <label class="flex items-center gap-2 rounded-lg border border-theme-700 bg-theme-800 px-2.5 py-1.5 focus-within:ring-1 focus-within:ring-accent-500">
            <Icon
              icon="lucide:search"
              class="h-3.5 w-3.5 shrink-0 text-theme-500"
            />
            <input
              v-model="search"
              type="search"
              class="min-w-0 flex-1 bg-transparent text-xs text-theme-200 outline-none placeholder:text-theme-600"
              placeholder="Search memory folders..."
              aria-label="Search memory folders"
            >
          </label>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto p-1.5">
          <div
            v-if="loading"
            class="px-3 py-6 text-center text-xs text-theme-500"
          >
            Loading…
          </div>
          <div
            v-else-if="visibleFolders.length === 0"
            class="px-3 py-6 text-center text-xs text-theme-500"
          >
            {{ search ? `No memory folders match “${search}”` : 'No memory folders found' }}
          </div>
          <template v-else>
            <template
              v-for="folder in visibleFolders"
              :key="folder.id"
            >
              <div
                class="group flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-theme-300 transition-colors hover:bg-theme-800/70 hover:text-theme-100"
                role="menuitem"
                tabindex="0"
                @click="toggleFolder(folder)"
                @keydown.enter.prevent="toggleFolder(folder)"
                @keydown.space.prevent="toggleFolder(folder)"
              >
                <button
                  type="button"
                  class="flex h-4 w-4 shrink-0 items-center justify-center rounded border"
                  :class="isSelected(folder) || isPartiallySelected(folder) ? 'border-accent-500 bg-accent-500 text-white' : 'border-theme-600 bg-theme-950'"
                  role="checkbox"
                  :aria-checked="isPartiallySelected(folder) ? 'mixed' : isSelected(folder)"
                  :aria-label="`Toggle ${folderLabel(folder)}`"
                  @click.stop="toggleFolder(folder)"
                >
                  <Icon
                    v-if="isSelected(folder)"
                    icon="lucide:check"
                    class="h-3 w-3"
                  />
                  <Icon
                    v-else-if="isPartiallySelected(folder)"
                    icon="lucide:minus"
                    class="h-3 w-3"
                  />
                </button>
                <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-theme-800">
                  <Icon
                    :icon="folder.isUncategorized ? 'lucide:hard-drive' : 'lucide:folder'"
                    class="h-4 w-4"
                    :class="isSelected(folder) || isPartiallySelected(folder) ? 'text-accent-400' : 'text-theme-500'"
                  />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-xs font-medium">{{ folderLabel(folder) }}</span>
                  <span class="mt-0.5 block truncate text-[10px] text-theme-500">
                    {{ folder.isUncategorized ? 'Uncategorized and standard folders' : `${folder.fileCount} document${folder.fileCount === 1 ? '' : 's'}` }}
                  </span>
                </span>
                <button
                  v-if="hasChildren(folder)"
                  type="button"
                  class="flex items-center rounded-lg p-1 text-theme-600 hover:bg-theme-700 hover:text-theme-300"
                  :aria-label="`Open ${folderLabel(folder)}`"
                  @click.stop="openFolder(folder)"
                >
                  <Icon
                    icon="lucide:chevron-right"
                    class="h-3.5 w-3.5 shrink-0"
                  />
                </button>
              </div>
              <div
                v-if="folder.isUncategorized"
                class="mx-2 my-1 border-t border-theme-700/70"
                role="separator"
              />
            </template>
          </template>
        </div>

        <div class="flex items-center justify-between border-t border-theme-800 px-3 py-2 text-[10px] text-theme-500">
          <span>{{ allSelected ? 'All memory selected' : `${selectedCount}/${folders.length} selected` }}</span>
          <div class="flex items-center gap-3">
            <button
              v-if="!allSelected && folders.length"
              type="button"
              class="text-accent-400 hover:text-accent-300"
              @click="selectAll"
            >
              Select all
            </button>
            <button
              v-if="selected.length"
              type="button"
              class="text-theme-400 hover:text-theme-200"
              @click="deselectAll"
            >
              Clear
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
