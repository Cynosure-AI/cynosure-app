<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../api/client'
import type { AgentDefinition, MemoryFolder } from '../../api/types'
import { Icon } from '@iconify/vue'
import BaseCard from '../shared/BaseCard.vue'
import ToggleSwitch from '../shared/ToggleSwitch.vue'
import { allMemoryFolderSelectionIds, isAutoExcludedMemoryFolder, isMemoryFolderSelected } from '../../utils/memory-folder-selection'

const props = defineProps<{ agent: AgentDefinition }>()
const emit = defineEmits<{ update: [field: string, value: unknown] }>()
const router = useRouter()

// --- Memory Folders ---
const allSpaces = ref<MemoryFolder[]>([])
const spacesLoading = ref(false)
const spacesLoaded = ref(false)
const collapsedFolders = ref<Set<string>>(new Set())

const assignedIds = computed(() => new Set(props.agent.memoryFolders ?? []))
const rootFolder = computed(() => allSpaces.value.find(space => space.isUncategorized))
const rootSelected = computed(() => Boolean(rootFolder.value && assignedIds.value.has(rootFolder.value.id)))

const assignedFolders = computed(() =>
  allSpaces.value.filter(s => assignedIds.value.has(s.id))
)
const effectiveAssignedCount = computed(() => allSpaces.value.filter(isSelected).length)
const missingFolderIds = computed(() => {
  if (!spacesLoaded.value) return []
  const availableIds = new Set(allSpaces.value.map(space => space.id))
  return (props.agent.memoryFolders ?? []).filter(id => !availableIds.has(id))
})

const visibleSpaces = computed(() =>
  allSpaces.value.filter((space) => {
    if (space.isUncategorized) return true
    const parts = (space.folderPath || '').split('/')
    for (let i = 1; i < parts.length; i++) {
      if (collapsedFolders.value.has(parts.slice(0, i).join('/'))) return false
    }
    return true
  })
)

async function loadFolders() {
  spacesLoading.value = true
  try {
    const spaces = await api.memoryFolders.list()
    allSpaces.value = [...spaces].sort((a, b) => {
      if (a.isUncategorized) return -1
      if (b.isUncategorized) return 1
      return (a.folderPath || '').localeCompare(b.folderPath || '')
    })
    spacesLoaded.value = true
    collapseFoldersWithChildren(allSpaces.value)
  } catch (err) {
    console.error('[memory] Failed to load spaces:', err)
  }
  spacesLoading.value = false
}

function collapseFoldersWithChildren(spaces: MemoryFolder[]) {
  const pathsWithChildren = new Set<string>()
  const paths = spaces
    .map((space) => space.folderPath || '')
    .filter(Boolean)

  for (const path of paths) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      pathsWithChildren.add(parts.slice(0, i).join('/'))
    }
  }

  collapsedFolders.value = pathsWithChildren
}

function toggleSpace(folderId: string) {
  const space = allSpaces.value.find((candidate) => candidate.id === folderId)
  if (!space) return

  const current = new Set(props.agent.memoryFolders ?? [])
  const scopedIds = memoryFolderScopeIds(space)

  if (space.isUncategorized) {
    current.clear()
    if (!rootSelected.value) current.add(space.id)
  } else if (rootSelected.value && isAutoExcludedMemoryFolder(space)) {
    if (current.has(folderId)) {
      for (const id of scopedIds) current.delete(id)
    } else {
      for (const id of scopedIds) current.add(id)
    }
  } else if (rootSelected.value) {
    current.clear()
    for (const id of scopedIds) current.add(id)
  } else if (current.has(folderId)) {
    for (const id of scopedIds) current.delete(id)
  } else {
    for (const id of scopedIds) current.add(id)
  }

  emit('update', 'memoryFolders', Array.from(current))
}

function selectAll() {
  emit('update', 'memoryFolders', allMemoryFolderSelectionIds(allSpaces.value))
}

function isSelected(space: MemoryFolder): boolean {
  return isMemoryFolderSelected(space, assignedIds.value, rootSelected.value)
}

function folderDepth(space: MemoryFolder): number {
  if (space.isUncategorized) return 0
  return Math.max(1, (space.folderPath || '').split('/').filter(Boolean).length)
}

function deselectAll() {
  emit('update', 'memoryFolders', [])
}

function removeMissingFolders() {
  const missingIds = new Set(missingFolderIds.value)
  emit('update', 'memoryFolders', (props.agent.memoryFolders ?? []).filter(id => !missingIds.has(id)))
}

function memoryFolderScopeIds(space: MemoryFolder): string[] {
  if (space.isUncategorized) return [space.id]
  const prefix = space.folderPath ? `${space.folderPath}/` : ''
  return allSpaces.value
    .filter((candidate) => candidate.id === space.id || Boolean(prefix && candidate.folderPath?.startsWith(prefix)))
    .map((candidate) => candidate.id)
}

function hasChildren(space: MemoryFolder): boolean {
  const prefix = space.folderPath ? `${space.folderPath}/` : ''
  return allSpaces.value.some((candidate) => space.isUncategorized ? Boolean(candidate.folderPath) : candidate.folderPath?.startsWith(prefix))
}

function isPartiallySelected(space: MemoryFolder): boolean {
  if (space.isUncategorized || !hasChildren(space)) return false
  // Show partial icon whenever children are selected but the parent itself is not
  if (assignedIds.value.has(space.id)) return false
  const prefix = `${space.folderPath}/`
  const directChildren = allSpaces.value.filter(c => c.folderPath?.startsWith(prefix))
  return directChildren.some(c => assignedIds.value.has(c.id))
}

function toggleCollapsed(space: MemoryFolder) {
  const key = space.folderPath || ''
  const next = new Set(collapsedFolders.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedFolders.value = next
}

function goToMemory() {
  router.push('/memory-folders')
}

onMounted(() => loadFolders())
</script>

<template>
  <div class="space-y-4">
    <!-- Dreaming eligibility -->
    <BaseCard class="p-5 bg-dream-card">
      <div class="flex items-start justify-between gap-4">
        <div class="flex-1">
          <div class="flex items-center gap-2 mb-1">
            <Icon
              icon="lucide:moon-star"
              class="w-4 h-4 text-accent-fg"
            />
            <h3 class="text-sm font-medium text-theme-200">
              Dreaming
            </h3>
          </div>
          <p class="text-xs text-theme-500 leading-relaxed">
            Allow conversations with this agent to be reviewed by Dream Mode after they become inactive. Enabled by default; turn this off to opt out.
          </p>
        </div>
        <ToggleSwitch
          :model-value="agent.dreamingEnabled !== false"
          label="Allow Dreaming for this agent"
          color="accent"
          class="mt-0.5"
          @update:model-value="emit('update', 'dreamingEnabled', $event)"
        />
      </div>
    </BaseCard>

    <!-- Automatic Memory Retrieval -->
    <BaseCard class="p-5">
      <div class="flex items-start justify-between gap-4">
        <div class="flex-1">
          <div class="flex items-center gap-2 mb-1">
            <Icon
              icon="lucide:brain-circuit"
              class="w-4 h-4 text-accent-fg"
            />
            <h3 class="text-sm font-medium text-theme-200">
              Automatic memory retrieval
            </h3>
          </div>
          <p class="text-xs text-theme-500 leading-relaxed">
            Retrieve and inject relevant document snippets before this agent responds. Relationship tools use the same selected-folder scope on demand.
          </p>
        </div>
        <ToggleSwitch
          :model-value="agent.autoMemory === true"
          label="Automatically retrieve memory"
          color="accent"
          class="mt-0.5"
          @update:model-value="emit('update', 'autoMemory', $event)"
        />
      </div>
    </BaseCard>

    <!-- Memory Folders -->
    <BaseCard class="p-5">
      <div class="flex items-center justify-between mb-1">
        <div class="flex items-center gap-2">
          <Icon
            icon="lucide:database"
            class="w-4 h-4 text-accent-fg"
          />
          <h3 class="text-sm font-medium text-theme-200">
            Memory Folders
          </h3>
        </div>
        <div class="flex items-center gap-2">
          <button
            class="px-2 py-1 text-xs text-theme-400 hover:text-theme-200 transition-colors flex items-center gap-1"
            @click="goToMemory"
          >
            <Icon
              icon="lucide:external-link"
              class="w-3 h-3"
            />
            Manage
          </button>
          <button
            :disabled="spacesLoading"
            class="px-2 py-1.5 text-xs text-theme-400 hover:text-theme-200 transition-colors"
            @click="loadFolders"
          >
            <Icon
              :icon="spacesLoading ? 'lucide:loader-2' : 'lucide:refresh-cw'"
              class="w-3.5 h-3.5"
              :class="{ 'animate-spin': spacesLoading }"
            />
          </button>
        </div>
      </div>
      <p class="text-xs text-theme-500 mb-3">
        Select memory folders to give this agent access to shared knowledge.
      </p>

      <div
        v-if="missingFolderIds.length"
        class="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3"
      >
        <div class="flex items-start gap-2">
          <Icon
            icon="lucide:alert-triangle"
            class="mt-0.5 h-4 w-4 shrink-0 text-status-warning"
          />
          <div class="min-w-0 flex-1">
            <p class="text-xs font-medium text-amber-300">
              {{ missingFolderIds.length }} assigned memory folder{{ missingFolderIds.length > 1 ? 's' : '' }} unavailable
            </p>
            <p class="mt-0.5 text-[11px] text-status-warning/60">
              These folders are assigned to this agent but no longer found in Memory.
            </p>
            <div class="mt-2 flex flex-wrap gap-1.5">
              <span
                v-for="id in missingFolderIds"
                :key="id"
                class="inline-flex max-w-full items-center gap-1 break-all rounded bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] text-amber-300/80"
              >
                <Icon
                  icon="lucide:folder-x"
                  class="h-3 w-3"
                />
                {{ id }}
              </span>
            </div>
            <button
              class="mt-2.5 flex items-center gap-1 text-[11px] font-medium text-status-warning transition-colors hover:text-amber-300"
              @click="removeMissingFolders"
            >
              <Icon
                icon="lucide:trash-2"
                class="h-3 w-3"
              />
              Remove unavailable folders
            </button>
          </div>
        </div>
      </div>

      <!-- Count + select all/none -->
      <div
        v-if="allSpaces.length > 0"
        class="mb-2 flex items-center justify-between text-xs"
      >
        <span class="text-theme-500">
          {{ effectiveAssignedCount === allSpaces.length ? 'All memory selected' : `${effectiveAssignedCount}/${allSpaces.length} selected` }}
        </span>
        <div class="flex items-center gap-3">
          <button
            v-if="effectiveAssignedCount < allSpaces.length"
            class="text-accent-fg hover:text-accent-fg transition-colors"
            @click="selectAll"
          >
            Select all
          </button>
          <button
            v-if="assignedFolders.length > 0"
            class="text-theme-400 hover:text-theme-200 transition-colors"
            @click="deselectAll"
          >
            Deselect all
          </button>
        </div>
      </div>

      <!-- Unified folder list -->
      <div class="rounded-lg border border-theme-700 overflow-hidden">
        <div
          v-if="spacesLoading"
          class="text-sm text-theme-500 text-center py-6"
        >
          <Icon
            icon="lucide:loader-2"
            class="w-4 h-4 animate-spin mx-auto mb-2"
          />
          Loading folders…
        </div>
        <div
          v-else-if="allSpaces.length === 0"
          class="text-center py-6"
        >
          <Icon
            icon="lucide:database"
            class="w-8 h-8 text-theme-700 mx-auto mb-2"
          />
          <p class="text-sm text-theme-500">
            No memory folders found
          </p>
        </div>
        <div
          v-else
          class="overflow-y-auto "
        >
          <div
            v-for="space in visibleSpaces"
            :key="space.id"
            class="flex items-center gap-2 w-full px-3 py-2.5 border-b border-theme-800 last:border-0 cursor-pointer transition-colors"
            :data-folder-depth="folderDepth(space)"
            :class="isSelected(space)
              ? 'bg-accent-600/10 hover:bg-accent-600/15'
              : isPartiallySelected(space)
                ? 'bg-accent-600/8 hover:bg-accent-600/12'
                : 'hover:bg-theme-800/60'"
            @click="toggleSpace(space.id)"
          >
            <!-- Indent spacer -->
            <span
              v-if="folderDepth(space) > 0"
              :style="{ width: `${folderDepth(space) * 12}px` }"
              class="shrink-0 self-stretch border-r border-theme-700/60"
              aria-hidden="true"
            />
            <!-- Chevron: always rendered to keep all rows aligned -->
            <button
              class="p-0.5 shrink-0 text-theme-500 hover:text-theme-200 transition-colors"
              :class="{ 'invisible pointer-events-none': space.isUncategorized || !hasChildren(space) }"
              @click.stop="toggleCollapsed(space)"
            >
              <Icon
                icon="lucide:chevron-down"
                class="w-3.5 h-3.5 transition-transform"
                :class="{ '-rotate-90': collapsedFolders.has(space.folderPath || '') }"
              />
            </button>
            <div class="w-7 h-7 rounded-lg bg-theme-800 flex items-center justify-center shrink-0">
              <Icon
                :icon="space.isUncategorized ? 'lucide:hard-drive' : 'lucide:folder'"
                class="w-3.5 h-3.5"
                :class="isSelected(space) || isPartiallySelected(space) ? 'text-accent-fg' : 'text-theme-500'"
              />
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-sm text-theme-200 truncate">
                {{ space.isUncategorized ? 'All Memory' : space.name }}
              </div>
              <div class="text-[11px] text-theme-500">
                {{ space.isUncategorized ? 'Includes Uncategorized and standard folders' : `${space.fileCount} doc${space.fileCount !== 1 ? 's' : ''}` }}
              </div>
            </div>
            <Icon
              v-if="isSelected(space) && !isPartiallySelected(space)"
              icon="mdi:check-circle"
              class="w-4 h-4 text-accent-fg shrink-0"
            />

            <Icon
              v-else-if="isPartiallySelected(space)"
              icon="mdi:minus-circle"
              class="w-4 h-4 text-accent-fg shrink-0"
            />
          </div>
        </div>
      </div>
    </BaseCard>
  </div>
</template>

<style scoped>
.bg-dream-card
{
  background: url("../../assets/img/settings/bg-dream.png") no-repeat center center;
  background-size: cover;
  background-position: center center;
}
</style>
