<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../api/client'
import type { AgentDefinition, MemoryCategory } from '../../api/types'
import { Icon } from '@iconify/vue'
import BaseCard from '../shared/BaseCard.vue'
import ToggleSwitch from '../shared/ToggleSwitch.vue'

const props = defineProps<{ agent: AgentDefinition }>()
const emit = defineEmits<{ update: [field: string, value: unknown] }>()
const router = useRouter()

// --- Memory Categories ---
const allSpaces = ref<MemoryCategory[]>([])
const spacesLoading = ref(false)
const collapsedFolders = ref<Set<string>>(new Set())

const assignedIds = computed(() => new Set(props.agent.memoryCategories ?? []))
const rootCategory = computed(() => allSpaces.value.find(space => space.isUncategorized))
const rootSelected = computed(() => Boolean(rootCategory.value && assignedIds.value.has(rootCategory.value.id)))

const assignedCategories = computed(() =>
  allSpaces.value.filter(s => assignedIds.value.has(s.id))
)
const effectiveAssignedCount = computed(() => rootSelected.value ? allSpaces.value.length : assignedCategories.value.length)

const visibleSpaces = computed(() =>
  allSpaces.value.filter((space) => {
    if (space.isUncategorized) return true
    const parts = (space.categoryPath || '').split('/')
    for (let i = 1; i < parts.length; i++) {
      if (collapsedFolders.value.has(parts.slice(0, i).join('/'))) return false
    }
    return true
  })
)

async function loadCategories() {
  spacesLoading.value = true
  try {
    const spaces = await api.memoryCategories.list()
    allSpaces.value = [...spaces].sort((a, b) => {
      if (a.isUncategorized) return -1
      if (b.isUncategorized) return 1
      return (a.categoryPath || '').localeCompare(b.categoryPath || '')
    })
    collapseFoldersWithChildren(allSpaces.value)
  } catch (err) {
    console.error('[memory] Failed to load spaces:', err)
  }
  spacesLoading.value = false
}

function collapseFoldersWithChildren(spaces: MemoryCategory[]) {
  const pathsWithChildren = new Set<string>()
  const paths = spaces
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

function toggleSpace(categoryId: string) {
  const space = allSpaces.value.find((candidate) => candidate.id === categoryId)
  if (!space) return

  const current = new Set(props.agent.memoryCategories ?? [])
  const scopedIds = memoryCategoryScopeIds(space)

  if (space.isUncategorized) {
    current.clear()
    if (!rootSelected.value) current.add(space.id)
  } else if (rootSelected.value) {
    current.clear()
    for (const id of scopedIds) current.add(id)
  } else if (current.has(categoryId)) {
    for (const id of scopedIds) current.delete(id)
  } else {
    for (const id of scopedIds) current.add(id)
  }

  emit('update', 'memoryCategories', Array.from(current))
}

function selectAll() {
  emit('update', 'memoryCategories', rootCategory.value ? [rootCategory.value.id] : allSpaces.value.map(space => space.id))
}

function isSelected(space: MemoryCategory): boolean {
  return rootSelected.value || assignedIds.value.has(space.id)
}

function categoryDepth(space: MemoryCategory): number {
  if (space.isUncategorized) return 0
  return Math.max(1, (space.categoryPath || '').split('/').filter(Boolean).length)
}

function deselectAll() {
  emit('update', 'memoryCategories', [])
}

function memoryCategoryScopeIds(space: MemoryCategory): string[] {
  if (space.isUncategorized) return [space.id]
  const prefix = space.categoryPath ? `${space.categoryPath}/` : ''
  return allSpaces.value
    .filter((candidate) => candidate.id === space.id || Boolean(prefix && candidate.categoryPath?.startsWith(prefix)))
    .map((candidate) => candidate.id)
}

function hasChildren(space: MemoryCategory): boolean {
  const prefix = space.categoryPath ? `${space.categoryPath}/` : ''
  return allSpaces.value.some((candidate) => space.isUncategorized ? Boolean(candidate.categoryPath) : candidate.categoryPath?.startsWith(prefix))
}

function isPartiallySelected(space: MemoryCategory): boolean {
  if (space.isUncategorized || !hasChildren(space)) return false
  // Show partial icon whenever children are selected but the parent itself is not
  if (assignedIds.value.has(space.id)) return false
  const prefix = `${space.categoryPath}/`
  const directChildren = allSpaces.value.filter(c => c.categoryPath?.startsWith(prefix))
  return directChildren.some(c => assignedIds.value.has(c.id))
}

function toggleCollapsed(space: MemoryCategory) {
  const key = space.categoryPath || ''
  const next = new Set(collapsedFolders.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedFolders.value = next
}

function goToMemory() {
  router.push('/memory-categories')
}

onMounted(() => loadCategories())
</script>

<template>
  <div class="space-y-4">
    <!-- Automatic Memory Retrieval -->
    <BaseCard class="p-5">
      <div class="flex items-start justify-between gap-4">
        <div class="flex-1">
          <div class="flex items-center gap-2 mb-1">
            <Icon
              icon="lucide:brain-circuit"
              class="w-4 h-4 text-accent-400"
            />
            <h3 class="text-sm font-medium text-theme-200">
              Automatic memory retrieval
            </h3>
          </div>
          <p class="text-xs text-theme-500 leading-relaxed">
            Retrieve and inject relevant document snippets before this agent responds. Relationship tools use the same selected-category scope on demand.
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

    <!-- Memory Categories -->
    <BaseCard class="p-5">
      <div class="flex items-center justify-between mb-1">
        <div class="flex items-center gap-2">
          <Icon
            icon="lucide:brain"
            class="w-4 h-4 text-accent-400"
          />
          <h3 class="text-sm font-medium text-theme-200">
            Memory Categories
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
            @click="loadCategories"
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
        Select memory categories to give this agent access to shared knowledge.
      </p>

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
            class="text-accent-400 hover:text-accent-300 transition-colors"
            @click="selectAll"
          >
            Select all
          </button>
          <button
            v-if="assignedCategories.length > 0"
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
          Loading categories…
        </div>
        <div
          v-else-if="allSpaces.length === 0"
          class="text-center py-6"
        >
          <Icon
            icon="lucide:brain"
            class="w-8 h-8 text-theme-700 mx-auto mb-2"
          />
          <p class="text-sm text-theme-500">
            No memory categories found
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
            :data-category-depth="categoryDepth(space)"
            :class="isSelected(space)
              ? 'bg-accent-600/10 hover:bg-accent-600/15'
              : isPartiallySelected(space)
                ? 'bg-accent-600/8 hover:bg-accent-600/12'
                : 'hover:bg-theme-800/60'"
            @click="toggleSpace(space.id)"
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
              class="p-0.5 shrink-0 text-theme-500 hover:text-theme-200 transition-colors"
              :class="{ 'invisible pointer-events-none': space.isUncategorized || !hasChildren(space) }"
              @click.stop="toggleCollapsed(space)"
            >
              <Icon
                icon="lucide:chevron-down"
                class="w-3.5 h-3.5 transition-transform"
                :class="{ '-rotate-90': collapsedFolders.has(space.categoryPath || '') }"
              />
            </button>
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
                {{ space.isUncategorized ? 'Includes Uncategorized and every subcategory' : `${space.fileCount} doc${space.fileCount !== 1 ? 's' : ''}` }}
              </div>
            </div>
            <Icon
              v-if="isSelected(space) && !isPartiallySelected(space)"
              icon="mdi:check-circle"
              class="w-4 h-4 text-accent-400 shrink-0"
            />

            <Icon
              v-else-if="isPartiallySelected(space)"
              icon="mdi:minus-circle"
              class="w-4 h-4 text-accent-300 shrink-0"
            />
          </div>
        </div>
      </div>
    </BaseCard>
  </div>
</template>
