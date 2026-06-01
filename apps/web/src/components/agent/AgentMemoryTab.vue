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

const availableSpaces = computed(() =>
  allSpaces.value.filter(s => !assignedIds.value.has(s.id))
)

const visibleAvailableSpaces = computed(() =>
  availableSpaces.value.filter((space) => {
    if (space.isDefault) return true
    const parts = (space.relativePath || '').split('/')
    for (let i = 1; i < parts.length; i++) {
      if (collapsedFolders.value.has(parts.slice(0, i).join('/'))) return false
    }
    return true
  })
)

const showSpacePicker = ref(false)

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

function assignSpace(spaceId: string) {
  const current = props.agent.memorySpaces ?? []
  if (!current.includes(spaceId)) {
    emit('update', 'memorySpaces', [...current, spaceId])
  }
  showSpacePicker.value = false
}

function unassignSpace(spaceId: string) {
  const current = props.agent.memorySpaces ?? []
  emit('update', 'memorySpaces', current.filter((id: string) => id !== spaceId))
}

function assignAllSpaces() {
  emit('update', 'memorySpaces', allSpaces.value.map((space) => space.id))
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
          <span class="text-xs text-theme-500">
            ({{ assignedSpaces.length }} selected)
          </span>
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
            Manage Folders
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
      <p class="text-xs text-theme-500 mb-4">
        Select memory folders to give this agent access to shared knowledge.
        Documents uploaded to those folders will be used for retrieval during conversations.
      </p>

      <!-- Assigned folders list -->
      <div
        v-if="assignedSpaces.length === 0"
        class="text-center py-6 border-2 border-dashed border-theme-700 rounded-lg"
      >
        <Icon
          icon="lucide:brain"
          class="w-8 h-8 text-theme-700 mx-auto mb-2"
        />
        <p class="text-sm text-theme-500">
          No memory folders selected
        </p>
        <p class="text-xs text-theme-600 mt-1">
          Select folders to give this agent access to knowledge documents
        </p>
      </div>

      <div
        v-else
        class="space-y-2"
      >
        <div
          v-for="space in assignedSpaces"
          :key="space.id"
          class="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-theme-600 bg-theme-900/40 hover:bg-theme-900/60 transition-colors group"
        >
          <Icon
            :icon="space.isDefault ? 'lucide:hard-drive' : 'lucide:folder'"
            class="w-4 h-4 text-accent-400 shrink-0"
          />
          <div class="flex-1 min-w-0">
            <div class="text-sm text-theme-200 truncate">
              {{ space.name }}
            </div>
            <div
              v-if="space.description"
              class="text-xs text-theme-500 truncate"
            >
              {{ space.description }}
            </div>
          </div>
          <span class="text-xs text-theme-500 shrink-0">
            {{ space.fileCount }} doc{{ space.fileCount !== 1 ? 's' : '' }}
          </span>
          <button
            class="p-1 rounded text-theme-600 hover:text-red-400 transition-colors shrink-0 opacity-0 group-hover:opacity-100"
            title="Remove from agent"
            @click="unassignSpace(space.id)"
          >
            <Icon
              icon="lucide:x"
              class="w-3.5 h-3.5"
            />
          </button>
        </div>
      </div>

      <!-- Add space button / picker -->
      <div class="mt-3 relative">
        <button
          v-if="!showSpacePicker"
          :disabled="availableSpaces.length === 0"
          class="w-full px-3 py-2 text-sm border border-dashed border-theme-700 rounded-lg text-theme-400 hover:text-theme-200 hover:border-theme-500 disabled:text-theme-600 disabled:hover:border-theme-700 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
          @click="showSpacePicker = true"
        >
          <Icon
            icon="lucide:plus"
            class="w-4 h-4"
          />
          {{ availableSpaces.length === 0 ? 'No more folders available' : 'Add Memory Folder' }}
        </button>

        <!-- Folder picker dropdown -->
        <div
          v-if="showSpacePicker"
          class="border border-theme-700 bg-theme-900 rounded-lg shadow-xl overflow-hidden"
        >
          <div class="px-3 py-2 border-b border-theme-800 flex items-center justify-between">
            <span class="text-xs text-theme-400 font-medium">Select folders</span>
            <div class="flex items-center gap-2">
              <button
                class="text-xs text-accent-400 hover:text-accent-300 transition-colors"
                @click="assignAllSpaces"
              >
                All
              </button>
              <button
                class="text-xs text-theme-500 hover:text-theme-300 transition-colors"
                @click="showSpacePicker = false"
              >
                Cancel
              </button>
            </div>
          </div>
          <div class="max-h-48 overflow-y-auto">
            <div
              v-for="space in visibleAvailableSpaces"
              :key="space.id"
              class="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-theme-800 transition-colors text-left"
              :style="{ paddingLeft: `${12 + (space.depth || 0) * 16}px` }"
            >
              <button
                class="p-0.5 text-theme-500 hover:text-theme-200"
                :class="{ 'invisible': !hasChildren(space) }"
                @click.stop="toggleCollapsed(space)"
              >
                <Icon
                  icon="lucide:chevron-down"
                  class="w-3.5 h-3.5 transition-transform"
                  :class="{ '-rotate-90': collapsedFolders.has(space.relativePath || '') }"
                />
              </button>
              <button
                class="flex flex-1 items-center gap-3 min-w-0 text-left"
                @click="assignSpace(space.id)"
              >
                <Icon
                  :icon="space.isDefault ? 'lucide:hard-drive' : 'lucide:folder'"
                  class="w-4 h-4 text-theme-500 shrink-0"
                />
                <div class="flex-1 min-w-0">
                  <div class="text-sm text-theme-200 truncate">
                    {{ space.name }}
                  </div>
                  <div
                    v-if="space.description"
                    class="text-xs text-theme-500 truncate"
                  >
                    {{ space.description }}
                  </div>
                </div>
                <span class="text-xs text-theme-500 shrink-0">
                  {{ space.fileCount }} doc{{ space.fileCount !== 1 ? 's' : '' }}
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </BaseCard>
  </div>
</template>
