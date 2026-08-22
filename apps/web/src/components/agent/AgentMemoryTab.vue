<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../api/client'
import type { AgentDefinition, MemorySpace } from '../../api/types'
import { Icon } from '@iconify/vue'
import BaseCard from '../shared/BaseCard.vue'
import ToggleSwitch from '../shared/ToggleSwitch.vue'
import { agentMemoryFolderName, agentMemoryRelativePath } from '../../utils/agent-memory'

const props = defineProps<{ agent: AgentDefinition }>()
const emit = defineEmits<{ update: [field: string, value: unknown] }>()
const router = useRouter()

// --- Memory Folders ---
const allSpaces = ref<MemorySpace[]>([])
const spacesLoading = ref(false)
const creatingAgentSpace = ref(false)
const createAgentSpaceError = ref<string | null>(null)
const collapsedFolders = ref<Set<string>>(new Set())

const assignedIds = computed(() => new Set(props.agent.memorySpaces ?? []))

const assignedSpaces = computed(() =>
  allSpaces.value.filter(s => assignedIds.value.has(s.id))
)

const agentSpacePath = computed(() => agentMemoryRelativePath(props.agent.internalName, props.agent.name))

const agentSpaceExists = computed(() =>
  allSpaces.value.some(s => s.relativePath === agentSpacePath.value)
)

const agentSpace = computed(() =>
  allSpaces.value.find(s => s.relativePath === agentSpacePath.value)
)

const agentSpaceAssigned = computed(() =>
  Boolean(agentSpace.value && assignedIds.value.has(agentSpace.value.id))
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
    collapseFoldersWithChildren(allSpaces.value)
  } catch (err) {
    console.error('[memory] Failed to load spaces:', err)
  }
  spacesLoading.value = false
}

function collapseFoldersWithChildren(spaces: MemorySpace[]) {
  const pathsWithChildren = new Set<string>()
  const paths = spaces
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

function toggleSpace(spaceId: string) {
  const space = allSpaces.value.find((candidate) => candidate.id === spaceId)
  if (!space) return

  const current = new Set(props.agent.memorySpaces ?? [])
  const scopedIds = memorySpaceScopeIds(space)

  if (current.has(spaceId)) {
    for (const id of scopedIds) current.delete(id)
  } else {
    for (const id of scopedIds) current.add(id)
  }

  emit('update', 'memorySpaces', Array.from(current))
}

function selectAll() {
  emit('update', 'memorySpaces', allSpaces.value.map((space) => space.id))
}

function deselectAll() {
  emit('update', 'memorySpaces', [])
}

async function createAgentMemorySpace() {
  if (creatingAgentSpace.value) return
  creatingAgentSpace.value = true
  createAgentSpaceError.value = null

  const folderName = agentMemoryFolderName(props.agent.internalName, props.agent.name)
  const relativePath = agentMemoryRelativePath(props.agent.internalName, props.agent.name)

  try {
    let created = allSpaces.value.find((space) => space.relativePath === relativePath)
    if (!created) {
      created = await api.memorySpaces.create(
        folderName,
        `Private memory folder for ${props.agent.name}`,
        'agents',
      )
    }

    await loadSpaces()
    const space = allSpaces.value.find((candidate) => candidate.relativePath === relativePath) || created
    const current = props.agent.memorySpaces ?? []
    if (space && !current.includes(space.id)) {
      emit('update', 'memorySpaces', [...current, space.id])
    }
  } catch (err) {
    console.error('[memory] Failed to create agent memory folder:', err)
    createAgentSpaceError.value = err instanceof Error ? err.message : 'Failed to create memory folder'
  } finally {
    creatingAgentSpace.value = false
  }
}

async function toggleAgentMemorySpace(enabled: boolean) {
  if (enabled) {
    await createAgentMemorySpace()
    return
  }

  const space = agentSpace.value
  if (!space) return
  emit('update', 'memorySpaces', (props.agent.memorySpaces ?? []).filter(id => id !== space.id))
}

function memorySpaceScopeIds(space: MemorySpace): string[] {
  if (space.isDefault) return [space.id]
  const prefix = space.relativePath ? `${space.relativePath}/` : ''
  return allSpaces.value
    .filter((candidate) => candidate.id === space.id || Boolean(prefix && candidate.relativePath?.startsWith(prefix)))
    .map((candidate) => candidate.id)
}

function hasChildren(space: MemorySpace): boolean {
  const prefix = space.relativePath ? `${space.relativePath}/` : ''
  return allSpaces.value.some((candidate) => space.isDefault ? Boolean(candidate.relativePath) : candidate.relativePath?.startsWith(prefix))
}

function isPartiallySelected(space: MemorySpace): boolean {
  if (space.isDefault || !hasChildren(space)) return false
  // Show partial icon whenever children are selected but the parent itself is not
  if (assignedIds.value.has(space.id)) return false
  const prefix = `${space.relativePath}/`
  const directChildren = allSpaces.value.filter(c => c.relativePath?.startsWith(prefix))
  return directChildren.some(c => assignedIds.value.has(c.id))
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

    <!-- Agent Memory Space -->
    <BaseCard class="p-5">
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 mb-1">
            <Icon
              icon="lucide:folder-plus"
              class="w-4 h-4 text-accent-400"
            />
            <h3 class="text-sm font-medium text-theme-200">
              Create Memory Space for Agent
            </h3>
          </div>
          <p class="text-xs text-theme-500 leading-relaxed">
            {{ agentSpaceExists ? 'Assigns' : 'Creates' }} <span class="font-mono text-theme-400">{{ agentSpacePath }}</span>{{ agentSpaceExists ? ' to this agent.' : ' and assigns it here.' }}
          </p>
          <p
            v-if="createAgentSpaceError"
            class="text-[11px] text-red-400 mt-1"
          >
            {{ createAgentSpaceError }}
          </p>
        </div>
        <ToggleSwitch
          :model-value="agentSpaceAssigned"
          :disabled="creatingAgentSpace || spacesLoading"
          label="Create and assign agent memory space"
          color="accent"
          class="mt-0.5"
          @update:model-value="toggleAgentMemorySpace"
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
        <div class="flex items-center gap-3">
          <button
            v-if="assignedSpaces.length < allSpaces.length"
            class="text-accent-400 hover:text-accent-300 transition-colors"
            @click="selectAll"
          >
            Select all
          </button>
          <button
            v-if="assignedSpaces.length > 0"
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
            :class="assignedIds.has(space.id)
              ? 'bg-accent-600/10 hover:bg-accent-600/15'
              : isPartiallySelected(space)
                ? 'bg-accent-600/8 hover:bg-accent-600/12'
                : 'hover:bg-theme-800/60'"
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
                :class="assignedIds.has(space.id) || isPartiallySelected(space) ? 'text-accent-400' : 'text-theme-500'"
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
              v-if="assignedIds.has(space.id) && !isPartiallySelected(space)"
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
