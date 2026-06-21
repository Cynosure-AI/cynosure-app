<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useChatStore } from '../../../stores/chat.store'
import type { MemorySpace } from '../../../api/types'
import { Icon } from '@iconify/vue'
import ModalDialog from '../../shared/ModalDialog.vue'
import ToggleSwitch from '../../shared/ToggleSwitch.vue'

const chatStore = useChatStore()

const visible = defineModel<boolean>({ required: true })

const loading = ref(false)
const collapsedFolders = ref<Set<string>>(new Set())
const spaces = computed(() => chatStore.memorySpaces)

watch(visible, async (val) => {
  if (!val) return
  loading.value = true
  try {
    await chatStore.loadMemorySpaces()
    collapseFoldersWithChildren(spaces.value)

    // Prune any stale IDs that no longer exist
    const validIds = new Set(spaces.value.map((space) => space.id))
    const nextSelected = chatStore.freeChatMemorySpaceIds.filter((id) => validIds.has(id))
    if (nextSelected.length !== chatStore.freeChatMemorySpaceIds.length) {
      chatStore.freeChatMemorySpaceIds.splice(
        0,
        chatStore.freeChatMemorySpaceIds.length,
        ...nextSelected,
      )
      chatStore.markOverridesModified()
    }
  } catch { /* ignore */ }
  loading.value = false
})

const selected = computed(() => chatStore.freeChatMemorySpaceIds)
const allSelected = computed(() => spaces.value.length > 0 && spaces.value.every((space) => selected.value.includes(space.id)))

function collapseFoldersWithChildren(memorySpaces: MemorySpace[]) {
  const pathsWithChildren = new Set<string>()
  const paths = memorySpaces
    .map((space) => space.relativePath || '')
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
    if (space.isDefault) return true
    const parts = (space.relativePath || '').split('/')
    for (let i = 1; i < parts.length; i++) {
      if (collapsedFolders.value.has(parts.slice(0, i).join('/'))) return false
    }
    return true
  })
)

function hasChildren(space: MemorySpace): boolean {
  const prefix = space.relativePath ? `${space.relativePath}/` : ''
  return spaces.value.some((candidate) => space.isDefault ? Boolean(candidate.relativePath) : candidate.relativePath?.startsWith(prefix))
}

function toggleCollapsed(space: MemorySpace) {
  const key = space.relativePath || ''
  const next = new Set(collapsedFolders.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedFolders.value = next
}

function selectAll() {
  chatStore.freeChatMemorySpaceIds.splice(0, chatStore.freeChatMemorySpaceIds.length, ...spaces.value.map((space) => space.id))
  chatStore.freeChatMemorySelectionInitialized = true
  chatStore.markOverridesModified()
}

function deselectAll() {
  chatStore.freeChatMemorySpaceIds.splice(0, chatStore.freeChatMemorySpaceIds.length)
  chatStore.freeChatMemorySelectionInitialized = true
  chatStore.markOverridesModified()
}

function toggle(id: string) {
  const space = spaces.value.find((candidate) => candidate.id === id)
  if (!space) return

  const current = new Set(chatStore.freeChatMemorySpaceIds)
  const scopedIds = memorySpaceScopeIds(space)

  if (current.has(id)) {
    for (const scopedId of scopedIds) current.delete(scopedId)
  } else {
    for (const scopedId of scopedIds) current.add(scopedId)
  }

  chatStore.freeChatMemorySpaceIds.splice(0, chatStore.freeChatMemorySpaceIds.length, ...current)
  chatStore.freeChatMemorySelectionInitialized = true
  chatStore.markOverridesModified()
}

function memorySpaceScopeIds(space: MemorySpace): string[] {
  if (space.isDefault) return [space.id]
  const prefix = space.relativePath ? `${space.relativePath}/` : ''
  return spaces.value
    .filter((candidate) => candidate.id === space.id || Boolean(prefix && candidate.relativePath?.startsWith(prefix)))
    .map((candidate) => candidate.id)
}

function toggleAutoMemory(enabled: boolean) {
  chatStore.sessionAutoMemory = enabled
  if (enabled && chatStore.freeChatMemorySpaceIds.length === 0 && spaces.value.length > 0) {
    const defaultSpace = spaces.value.find((space) => space.isDefault)
    const defaultIds = defaultSpace ? memorySpaceScopeIds(defaultSpace) : spaces.value.map((space) => space.id)
    chatStore.freeChatMemorySpaceIds.splice(0, chatStore.freeChatMemorySpaceIds.length, ...defaultIds)
  }
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
            Auto Memories
          </div>
          <div class="text-[11px] text-theme-500 leading-relaxed">
            Retrieve relevant snippets from selected folders before sending.
          </div>
        </div>
      </div>
      <ToggleSwitch
        :model-value="chatStore.sessionAutoMemory"
        class="mt-0.5 shrink-0"
        @update:model-value="toggleAutoMemory"
      />
    </div>

    <div
      v-if="spaces.length > 0"
      class="mb-2 flex items-center justify-between text-xs"
    >
      <span class="text-theme-500">
        {{ allSelected ? 'All folders selected' : `${selected.length}/${spaces.length} folders selected` }}
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
        :class="selected.includes(space.id)
          ? 'bg-accent-600/15 border border-accent-500/30'
          : 'hover:bg-theme-800 border border-transparent'"
      >
        <!-- Indent spacer -->
        <span
          v-if="(space.depth || 0) > 0"
          :style="{ width: `${(space.depth || 0) * 8}px` }"
          class="shrink-0"
        />
        <!-- Chevron: always rendered to keep all rows aligned -->
        <button
          class="p-0.5 shrink-0 text-theme-500 hover:text-theme-200"
          :class="{ 'invisible pointer-events-none': space.isDefault || !hasChildren(space) }"
          @click.stop="toggleCollapsed(space)"
        >
          <Icon
            icon="lucide:chevron-down"
            class="w-3.5 h-3.5 transition-transform"
            :class="{ '-rotate-90': collapsedFolders.has(space.relativePath || '') }"
          />
        </button>
        <!-- Folder name / toggle selection -->
        <button
          class="flex items-center gap-3 flex-1 min-w-0 text-left"
          @click="toggle(space.id)"
        >
          <div class="w-7 h-7 rounded-lg bg-theme-800 flex items-center justify-center shrink-0">
            <Icon
              :icon="space.isDefault ? 'lucide:hard-drive' : 'lucide:folder'"
              class="w-3.5 h-3.5"
              :class="selected.includes(space.id) ? 'text-accent-400' : 'text-theme-500'"
            />
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-sm text-theme-200 truncate">
              {{ space.name }}
            </div>
            <div class="text-[11px] text-theme-500">
              {{ space.fileCount }} document{{ space.fileCount !== 1 ? 's' : '' }}
            </div>
          </div>
          <Icon
            v-if="selected.includes(space.id)"
            icon="mdi:check-circle"
            class="w-4 h-4 text-accent-400 shrink-0"
          />
        </button>
      </div>
    </div>
  </ModalDialog>
</template>
