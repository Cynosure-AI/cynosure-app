<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAgentHealthStore } from '../../stores/agent-health.store'
import { api } from '../../api/client'
import type { AgentDefinition, MemoryFolder } from '../../api/types'
import { Icon } from '@iconify/vue'
import BaseCard from '../shared/BaseCard.vue'
import ToggleSwitch from '../shared/ToggleSwitch.vue'
import MemoryFolderPicker from '../memory/MemoryFolderPicker.vue'

const props = defineProps<{ agent: AgentDefinition }>()
const emit = defineEmits<{ update: [field: string, value: unknown] }>()
const router = useRouter()
const agentHealth = useAgentHealthStore()

// --- Memory Folders ---
const allSpaces = ref<MemoryFolder[]>([])
const spacesLoading = ref(false)

const missingFolderIds = computed(() => agentHealth.validate(props.agent).memoryFolders)

async function loadFolders() {
  spacesLoading.value = true
  try {
    const spaces = await api.memoryFolders.list()
    allSpaces.value = spaces
    agentHealth.memoryFolderIds = new Set(spaces.map(space => space.id))
  } catch (err) {
    console.error('[memory] Failed to load spaces:', err)
  }
  spacesLoading.value = false
}

function removeMissingFolders() {
  const missingIds = new Set(missingFolderIds.value)
  emit('update', 'memoryFolders', (props.agent.memoryFolders ?? []).filter(id => !missingIds.has(id)))
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
          <p class="text-xs text-ink-muted leading-relaxed">
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
          <p class="text-xs text-ink-muted leading-relaxed">
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
            class="px-2 py-1 text-xs text-ink-secondary hover:text-theme-200 transition-colors flex items-center gap-1"
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
            class="px-2 py-1.5 text-xs text-ink-secondary hover:text-theme-200 transition-colors"
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
      <p class="text-xs text-ink-muted mb-3">
        Select memory folders to give this agent access to shared knowledge. A folder always includes its subfolders.
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

      <MemoryFolderPicker
        :folders="allSpaces"
        :model-value="agent.memoryFolders ?? []"
        :loading="spacesLoading"
        @update:model-value="emit('update', 'memoryFolders', $event)"
      />
    </BaseCard>
  </div>
</template>

<style scoped>
.bg-dream-card {
  background: url("../../assets/img/settings/bg-dream.svg") no-repeat center;
  background-size: cover;
}
</style>
