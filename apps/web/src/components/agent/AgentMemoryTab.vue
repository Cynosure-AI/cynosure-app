<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../api/client'
import type { AgentDefinition, MemorySpace } from '../../api/types'
import { Icon } from '@iconify/vue'

const props = defineProps<{ agent: AgentDefinition }>()
const emit = defineEmits<{ update: [field: string, value: unknown] }>()
const router = useRouter()

// --- Memory Spaces ---
const allSpaces = ref<MemorySpace[]>([])
const spacesLoading = ref(false)

const assignedIds = computed(() => new Set(props.agent.memorySpaces ?? []))

const assignedSpaces = computed(() =>
  allSpaces.value.filter(s => assignedIds.value.has(s.id))
)

const availableSpaces = computed(() =>
  allSpaces.value.filter(s => !assignedIds.value.has(s.id))
)

const showSpacePicker = ref(false)

async function loadSpaces() {
  spacesLoading.value = true
  try {
    allSpaces.value = await api.memorySpaces.list()
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

function goToMemory() {
  router.push('/memory-spaces')
}

onMounted(() => loadSpaces())
</script>

<template>
  <div class="space-y-4">
    <!-- Memory Spaces -->
    <div class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <div class="flex items-center justify-between mb-1">
        <div class="flex items-center gap-2">
          <Icon
            icon="lucide:brain"
            class="w-4 h-4 text-blue-400"
          />
          <h3 class="text-sm font-medium text-zinc-200">
            Memory Spaces
          </h3>
          <span class="text-xs text-zinc-500">
            ({{ assignedSpaces.length }} assigned)
          </span>
        </div>
        <div class="flex items-center gap-2">
          <button
            class="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors flex items-center gap-1"
            @click="goToMemory"
          >
            <Icon
              icon="lucide:external-link"
              class="w-3 h-3"
            />
            Manage Spaces
          </button>
          <button
            :disabled="spacesLoading"
            class="px-2 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
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
      <p class="text-xs text-zinc-500 mb-4">
        Assign memory spaces to give this agent access to shared knowledge bases.
        Documents uploaded to those spaces will be used for retrieval during conversations.
      </p>

      <!-- Assigned spaces list -->
      <div
        v-if="assignedSpaces.length === 0"
        class="text-center py-6 border-2 border-dashed border-zinc-800 rounded-lg"
      >
        <Icon
          icon="lucide:brain"
          class="w-8 h-8 text-zinc-700 mx-auto mb-2"
        />
        <p class="text-sm text-zinc-500">
          No memory spaces assigned
        </p>
        <p class="text-xs text-zinc-600 mt-1">
          Add a space to give this agent access to knowledge documents
        </p>
      </div>

      <div
        v-else
        class="space-y-2"
      >
        <div
          v-for="space in assignedSpaces"
          :key="space.id"
          class="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-zinc-800 bg-zinc-800/30 hover:bg-zinc-800/50 transition-colors group"
        >
          <Icon
            icon="lucide:database"
            class="w-4 h-4 text-blue-400 shrink-0"
          />
          <div class="flex-1 min-w-0">
            <div class="text-sm text-zinc-200 truncate">
              {{ space.name }}
            </div>
            <div
              v-if="space.description"
              class="text-xs text-zinc-500 truncate"
            >
              {{ space.description }}
            </div>
          </div>
          <span class="text-xs text-zinc-500 shrink-0">
            {{ space.documentCount }} doc{{ space.documentCount !== 1 ? 's' : '' }}
          </span>
          <button
            class="p-1 rounded text-zinc-600 hover:text-red-400 transition-colors shrink-0 opacity-0 group-hover:opacity-100"
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
          class="w-full px-3 py-2 text-sm border border-dashed border-zinc-700 rounded-lg text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 disabled:text-zinc-600 disabled:hover:border-zinc-700 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
          @click="showSpacePicker = true"
        >
          <Icon
            icon="lucide:plus"
            class="w-4 h-4"
          />
          {{ availableSpaces.length === 0 ? 'No more spaces available' : 'Add Memory Space' }}
        </button>

        <!-- Space picker dropdown -->
        <div
          v-if="showSpacePicker"
          class="border border-zinc-700 bg-zinc-900 rounded-lg shadow-xl overflow-hidden"
        >
          <div class="px-3 py-2 border-b border-zinc-800 flex items-center justify-between">
            <span class="text-xs text-zinc-400 font-medium">Select a space</span>
            <button
              class="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              @click="showSpacePicker = false"
            >
              Cancel
            </button>
          </div>
          <div class="max-h-48 overflow-y-auto">
            <button
              v-for="space in availableSpaces"
              :key="space.id"
              class="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-zinc-800 transition-colors text-left"
              @click="assignSpace(space.id)"
            >
              <Icon
                icon="lucide:database"
                class="w-4 h-4 text-zinc-500 shrink-0"
              />
              <div class="flex-1 min-w-0">
                <div class="text-sm text-zinc-200 truncate">
                  {{ space.name }}
                </div>
                <div
                  v-if="space.description"
                  class="text-xs text-zinc-500 truncate"
                >
                  {{ space.description }}
                </div>
              </div>
              <span class="text-xs text-zinc-500 shrink-0">
                {{ space.documentCount }} doc{{ space.documentCount !== 1 ? 's' : '' }}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
