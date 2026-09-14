<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useChatStore } from '../../../stores/chat.store'
import type { MemoryFolder } from '../../../api/types'
import { Icon } from '@iconify/vue'
import ModalDialog from '../../shared/ModalDialog.vue'
import ToggleSwitch from '../../shared/ToggleSwitch.vue'

const chatStore = useChatStore()

const visible = defineModel<boolean>({ required: true })

const loading = ref(false)
const collapsedFolders = ref<Set<string>>(new Set())
const spaces = computed(() => chatStore.memoryFolders)

watch(visible, async (val) => {
  if (!val) return
  loading.value = true
  try {
    await chatStore.loadMemoryFolders()
    collapseFoldersWithChildren(spaces.value)

    // Prune any stale IDs that no longer exist
    const validIds = new Set(spaces.value.map((space) => space.id))
    const nextSelected = chatStore.freeChatMemoryFolderIds.filter((id) => validIds.has(id))
    if (nextSelected.length !== chatStore.freeChatMemoryFolderIds.length) {
      chatStore.freeChatMemoryFolderIds.splice(
        0,
        chatStore.freeChatMemoryFolderIds.length,
        ...nextSelected,
      )
      chatStore.markOverridesModified()
    }
  } catch { /* ignore */ }
  loading.value = false
})

const selected = computed(() => chatStore.freeChatMemoryFolderIds)
const rootCategory = computed(() => spaces.value.find(space => space.isUncategorized))
const rootSelected = computed(() => Boolean(rootCategory.value && selected.value.includes(rootCategory.value.id)))
const allSelected = computed(() => spaces.value.length > 0 && (rootSelected.value || spaces.value.every((space) => selected.value.includes(space.id))))
const effectiveSelectedCount = computed(() => rootSelected.value ? spaces.value.length : spaces.value.filter(space => selected.value.includes(space.id)).length)

function collapseFoldersWithChildren(memoryFolders: MemoryFolder[]) {
  const pathsWithChildren = new Set<string>()
  const paths = memoryFolders
    .map((space) => space.categoryPath || '')
    .filter(Boolean)

  for (const path of paths) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      pathsWithChildren.add(parts.slice(0, i).join('/'))
    }
  }

  collapsedFolders.value = pathsWithChildren
}

const visibleSpaces = computed(() =>
  spaces.value.filter((space) => {
    if (space.isUncategorized) return true
    const parts = (space.categoryPath || '').split('/')
    for (let i = 1; i < parts.length; i++) {
      if (collapsedFolders.value.has(parts.slice(0, i).join('/'))) return false
    }
    return true
  })
)

function hasChildren(space: MemoryFolder): boolean {
  const prefix = space.categoryPath ? `${space.categoryPath}/` : ''
  return spaces.value.some((candidate) => space.isUncategorized ? Boolean(candidate.categoryPath) : candidate.categoryPath?.startsWith(prefix))
}

function isPartiallySelected(space: MemoryFolder): boolean {
  if (space.isUncategorized || !hasChildren(space)) return false
  // Show partial icon whenever children are selected but the parent itself is not
  if (selected.value.includes(space.id)) return false
  const prefix = `${space.categoryPath}/`
  const directChildren = spaces.value.filter(c => c.categoryPath?.startsWith(prefix))
  return directChildren.some(c => selected.value.includes(c.id))
}

function toggleCollapsed(space: MemoryFolder) {
  const key = space.categoryPath || ''
  const next = new Set(collapsedFolders.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedFolders.value = next
}

function selectAll() {
  const ids = rootCategory.value ? [rootCategory.value.id] : spaces.value.map(space => space.id)
  chatStore.freeChatMemoryFolderIds.splice(0, chatStore.freeChatMemoryFolderIds.length, ...ids)
  chatStore.freeChatMemorySelectionInitialized = true
  chatStore.markOverridesModified()
}

function deselectAll() {
  chatStore.freeChatMemoryFolderIds.splice(0, chatStore.freeChatMemoryFolderIds.length)
  chatStore.freeChatMemorySelectionInitialized = true
  chatStore.markOverridesModified()
}

function toggle(id: string) {
  const space = spaces.value.find((candidate) => candidate.id === id)
  if (!space) return

  const current = new Set(chatStore.freeChatMemoryFolderIds)
  const scopedIds = memoryFolderScopeIds(space)

  if (space.isUncategorized) {
    current.clear()
    if (!rootSelected.value) current.add(space.id)
  } else if (rootSelected.value) {
    // Moving from the root grant to a child means narrowing the scope to that subtree.
    current.clear()
    for (const scopedId of scopedIds) current.add(scopedId)
  } else if (current.has(id)) {
    for (const scopedId of scopedIds) current.delete(scopedId)
  } else {
    for (const scopedId of scopedIds) current.add(scopedId)
  }

  chatStore.freeChatMemoryFolderIds.splice(0, chatStore.freeChatMemoryFolderIds.length, ...current)
  chatStore.freeChatMemorySelectionInitialized = true
  chatStore.markOverridesModified()
}

function isSelected(space: MemoryFolder): boolean {
  return rootSelected.value || selected.value.includes(space.id)
}

function categoryDepth(space: MemoryFolder): number {
  if (space.isUncategorized) return 0
  return Math.max(1, (space.categoryPath || '').split('/').filter(Boolean).length)
}

function memoryFolderScopeIds(space: MemoryFolder): string[] {
  if (space.isUncategorized) return [space.id]
  const prefix = space.categoryPath ? `${space.categoryPath}/` : ''
  return spaces.value
    .filter((candidate) => candidate.id === space.id || Boolean(prefix && candidate.categoryPath?.startsWith(prefix)))
    .map((candidate) => candidate.id)
}

function toggleAutoMemory(enabled: boolean) {
  chatStore.sessionAutoMemory = enabled
  chatStore.freeChatMemorySelectionInitialized = true
  chatStore.markOverridesModified()
}
</script>

<template>
  <ModalDialog
    :show="visible"
    title="Memory Folders"
    icon="lucide:brain"
    icon-color="accent"
    max-width="max-w-lg"
    @close="visible = false"
  >
    <div class="mb-4 rounded-lg border border-theme-700 bg-theme-900/50 p-3 flex items-start justify-between gap-3">
      <div class="flex items-start gap-3 min-w-0">
        <div class="w-7 h-7 rounded-lg bg-theme-800 flex items-center justify-center shrink-0">
          <Icon
            icon="lucide:brain-circuit"
            class="w-3.5 h-3.5 text-accent-400"
          />
        </div>
        <div class="min-w-0">
          <div class="text-sm text-theme-200">
            Automatic memory retrieval
          </div>
          <div class="text-[11px] text-theme-500 leading-relaxed">
            Retrieve relevant snippets from selected folders before sending.
          </div>
        </div>
      </div>
      <ToggleSwitch
        :model-value="chatStore.sessionAutoMemory"
        label="Automatically retrieve relevant memory"
        class="mt-0.5 shrink-0"
        @update:model-value="toggleAutoMemory"
      />
    </div>

    <div
      v-if="spaces.length > 0"
      class="mb-2 flex items-center justify-between text-xs"
    >
      <span class="text-theme-500">
        {{ allSelected ? 'All memory selected' : `${effectiveSelectedCount}/${spaces.length} folders selected` }}
      </span>
      <div class="flex items-center gap-4">
        <button
          v-if="!allSelected"
          class="text-accent-400 hover:text-accent-300"
          @click="selectAll"
        >
          Select all
        </button>
        <button
          v-if="selected.length > 0"
          class="text-theme-400 hover:text-theme-200"
          @click="deselectAll"
        >
          Deselect all
        </button>
      </div>
    </div>

    <!-- Folder list -->
    <div class="overflow-y-auto space-y-1">
      <div
        v-if="loading"
        class="text-sm text-theme-500 text-center py-6"
      >
        Loading…
      </div>
      <div
        v-else-if="spaces.length === 0"
        class="text-sm text-theme-500 text-center py-6"
      >
        No memory folders found
      </div>
      <div
        v-for="space in visibleSpaces"
        :key="space.id"
        class="flex items-center gap-2 w-full px-3 py-2.5 rounded-lg transition-colors text-left"
        :data-category-depth="categoryDepth(space)"
        :class="isSelected(space)
          ? 'bg-accent-600/15 border border-accent-500/30'
          : isPartiallySelected(space)
            ? 'bg-accent-600/8 border border-accent-500/15 hover:bg-accent-600/12'
            : 'hover:bg-theme-800 border border-transparent'"
      >
        <!-- Indent spacer -->
        <span
          v-if="categoryDepth(space) > 0"
          :style="{ width: `${categoryDepth(space) * 12}px` }"
          class="shrink-0 self-stretch border-r border-theme-700/60"
          aria-hidden="true"
        />
        <!-- Chevron: always rendered to keep all rows aligned -->
        <button
          class="p-0.5 shrink-0 text-theme-500 hover:text-theme-200"
          :class="{ 'invisible pointer-events-none': space.isUncategorized || !hasChildren(space) }"
          @click.stop="toggleCollapsed(space)"
        >
          <Icon
            icon="lucide:chevron-down"
            class="w-3.5 h-3.5 transition-transform"
            :class="{ '-rotate-90': collapsedFolders.has(space.categoryPath || '') }"
          />
        </button>
        <!-- Folder name / toggle selection -->
        <button
          class="flex items-center gap-3 flex-1 min-w-0 text-left"
          @click="toggle(space.id)"
        >
          <div class="w-7 h-7 rounded-lg bg-theme-800 flex items-center justify-center shrink-0">
            <Icon
              :icon="space.isUncategorized ? 'lucide:hard-drive' : 'lucide:folder'"
              class="w-3.5 h-3.5"
              :class="isSelected(space) || isPartiallySelected(space) ? 'text-accent-400' : 'text-theme-500'"
            />
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-sm text-theme-200 truncate">
              {{ space.isUncategorized ? 'All Memory' : space.name }}
            </div>
            <div class="text-[11px] text-theme-500">
              {{ space.isUncategorized ? 'Includes Uncategorized and every subfolder' : `${space.fileCount} document${space.fileCount !== 1 ? 's' : ''}` }}
            </div>
          </div>
          <Icon
            v-if="isSelected(space)"
            icon="mdi:check-circle"
            class="w-4 h-4 text-accent-400 shrink-0"
          />

          <Icon
            v-else-if="isPartiallySelected(space)"
            icon="mdi:minus-circle"
            class="w-4 h-4 text-accent-300 shrink-0"
          />
        </button>
      </div>
    </div>
  </ModalDialog>
</template>
