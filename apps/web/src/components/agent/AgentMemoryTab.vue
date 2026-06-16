<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../api/client'
import type { AgentDefinition, MemorySpace } from '../../api/types'
import { Icon } from '@iconify/vue'
import BaseCard from '../shared/BaseCard.vue'
import ToggleSwitch from '../shared/ToggleSwitch.vue'

const props = defineProps<{ agent: AgentDefinition }>()
const emit = defineEmits<{ update: [field: string, value: unknown] }>()
const router = useRouter()

// --- Memory Folders ---
const allSpaces = ref<MemorySpace[]>([])
const spacesLoading = ref(false)
const collapsedFolders = ref<Set<string>>(new Set())

const assignedIds = computed(() => new Set(props.agent.memorySpaces ?? []))

const assignedSpaces = computed(() =>
  allSpaces.value.filter(s => assignedIds.value.has(s.id))
)

const visibleSpaces = computed(() =>
  allSpaces.value.filter((space) => {
    if (space.isDefault) return true
    const parts = (space.relativePath || '').split('/')
    for (let i = 1; i < parts.length; i++) {
      if (collapsedFolders.value.has(parts.slice(0, i).join('/'))) return false
    }
    return true
  })
)

async function loadSpaces() {
  spacesLoading.value = true
  try {
    const spaces = await api.memorySpaces.list()
    allSpaces.value = [...spaces].sort((a, b) => {
      if (a.isDefault) return -1
      if (b.isDefault) return 1
      return (a.relativePath || '').localeCompare(b.relativePath || '')
    })
  } catch (err) {
    console.error('[memory] Failed to load spaces:', err)
  }
  spacesLoading.value = false
}

function toggleSpace(spaceId: string) {
  const current = props.agent.memorySpaces ?? []
  if (current.includes(spaceId)) {
    emit('update', 'memorySpaces', current.filter((id: string) => id !== spaceId))
  } else {
    emit('update', 'memorySpaces', [...current, spaceId])
  }
}

function selectAll() {
  emit('update', 'memorySpaces', allSpaces.value.map((space) => space.id))
}

function deselectAll() {
  emit('update', 'memorySpaces', [])
}

function hasChildren(space: MemorySpace): boolean {
  const prefix = space.relativePath ? `${space.relativePath}/` : ''
  return allSpaces.value.some((candidate) => space.isDefault ? Boolean(candidate.relativePath) : candidate.relativePath?.startsWith(prefix))
}

function toggleCollapsed(space: MemorySpace) {
  const key = space.relativePath || ''
  const next = new Set(collapsedFolders.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedFolders.value = next
}

function goToMemory() {
  router.push('/memory-spaces')
}

onMounted(() => loadSpaces())
</script>

<template>
  <div class="space-y-4">
    <!-- Auto Memories -->
    <BaseCard class="p-5">
      <div class="flex items-start justify-between gap-4">
        <div class="flex-1">
          <div class="flex items-center gap-2 mb-1">
            <Icon
              icon="lucide:brain-circuit"
              class="w-4 h-4 text-accent-400"
            />
            <h3 class="text-sm font-medium text-theme-200">
              Auto Memories
            </h3>
          </div>
          <p class="text-xs text-theme-500 leading-relaxed">
            Automatically retrieve and inject relevant memory snippets before this agent responds.
          </p>
        </div>
        <ToggleSwitch
          :model-value="agent.autoMemory === true"
          color="accent"
          class="mt-0.5"
          @update:model-value="emit('update', 'autoMemory', $event)"
        />
      </div>
    </BaseCard>

    <!-- Memory Spaces -->
    <BaseCard class="p-5">
      <div class="flex items-center justify-between mb-1">
        <div class="flex items-center gap-2">
          <Icon
            icon="lucide:brain"
            class="w-4 h-4 text-accent-400"
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
            @click="loadSpaces"
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

      <!-- Count + select all/none -->
      <div
        v-if="allSpaces.length > 0"
        class="mb-2 flex items-center justify-between text-xs"
      >
        <span class="text-theme-500">
          {{ assignedSpaces.length === allSpaces.length ? 'All folders selected' : `${assignedSpaces.length}/${allSpaces.length} selected` }}
        </span>
        <button
          v-if="assignedSpaces.length < allSpaces.length"
          class="text-accent-400 hover:text-accent-300 transition-colors"
          @click="selectAll"
        >
          Select all
        </button>
        <button
          v-else
          class="text-theme-400 hover:text-theme-200 transition-colors"
          @click="deselectAll"
        >
          Deselect all
        </button>
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
            icon="lucide:brain"
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
            :class="assignedIds.has(space.id) ? 'bg-accent-600/10 hover:bg-accent-600/15' : 'hover:bg-theme-800/60'"
            @click="toggleSpace(space.id)"
          >
            <!-- Indent spacer -->
            <span
              v-if="(space.depth || 0) > 0"
              :style="{ width: `${(space.depth || 0) * 8}px` }"
              class="shrink-0"
            />
            <!-- Chevron: always rendered to keep all rows aligned -->
            <button
              class="p-0.5 shrink-0 text-theme-500 hover:text-theme-200 transition-colors"
              :class="{ 'invisible pointer-events-none': space.isDefault || !hasChildren(space) }"
              @click.stop="toggleCollapsed(space)"
            >
              <Icon
                icon="lucide:chevron-down"
                class="w-3.5 h-3.5 transition-transform"
                :class="{ '-rotate-90': collapsedFolders.has(space.relativePath || '') }"
              />
            </button>
            <div class="w-7 h-7 rounded-lg bg-theme-800 flex items-center justify-center shrink-0">
              <Icon
                :icon="space.isDefault ? 'lucide:hard-drive' : 'lucide:folder'"
                class="w-3.5 h-3.5"
                :class="assignedIds.has(space.id) ? 'text-accent-400' : 'text-theme-500'"
              />
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-sm text-theme-200 truncate">
                {{ space.name }}
              </div>
              <div class="text-[11px] text-theme-500">
                {{ space.fileCount }} doc{{ space.fileCount !== 1 ? 's' : '' }}
              </div>
            </div>
            <Icon
              v-if="assignedIds.has(space.id)"
              icon="mdi:check-circle"
              class="w-4 h-4 text-accent-400 shrink-0"
            />
          </div>
        </div>
      </div>
    </BaseCard>
  </div>
</template>
