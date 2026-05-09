<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useChatStore } from '../../../stores/chat.store'
import { Icon } from '@iconify/vue'
import { api } from '../../../api/client'
import type { MemorySpace } from '../../../api/types'
import HoverTooltip from '../../shared/HoverTooltip.vue'
import MemorySpaceSelectorModal from '../modals/MemorySpaceSelectorModal.vue'

const chatStore = useChatStore()

const showModal = ref(false)

const cachedMemorySpaces = ref<MemorySpace[]>([])

async function loadMemorySpaces() {
  try { cachedMemorySpaces.value = await api.memorySpaces.list() } catch { /* ignore */ }
}

onMounted(loadMemorySpaces)

// Reload memory spaces when modal visibility changes
watch(showModal, () => {
  loadMemorySpaces()
})

const selectedMemorySpaces = computed(() => {
  const ids = chatStore.freeChatMemorySpaceIds
  return cachedMemorySpaces.value.filter(s => ids.includes(s.id))
})

const memorySpaceCount = computed(() => selectedMemorySpaces.value.length)
</script>

<template>
  <HoverTooltip :max-width="260">
    <button
      class="relative p-2.5 rounded-xl transition-colors shrink-0 focus:outline-none focus:ring-1 focus:ring-blue-500 text-zinc-500 hover:text-zinc-300"
      aria-label="Memory spaces"
      @click="showModal = true"
    >
      <Icon
        icon="lucide:brain"
        class="h-5 w-5"
      />
      <span
        v-if="memorySpaceCount > 0"
        class="absolute -top-0.5 -right-0.5 min-w-4 h-4 flex items-center justify-center rounded-full text-[9px] font-bold text-white px-1 leading-none bg-blue-600"
      >
        {{ memorySpaceCount }}
      </span>
    </button>
    <template #content>
      <div class="font-medium text-zinc-300 mb-1.5">
        Memory Spaces ({{ memorySpaceCount }} selected)
      </div>
      <template v-if="selectedMemorySpaces.length">
        <div
          v-for="s in selectedMemorySpaces.slice(0, 6)"
          :key="s.id"
          class="flex items-start gap-1.5 mb-1 last:mb-0"
        >
          <Icon
            icon="lucide:database"
            class="w-3 h-3 text-purple-400 shrink-0 mt-0.5"
          />
          <div class="min-w-0">
            <div class="text-zinc-300 text-[11px] truncate">
              {{ s.name }}
            </div>
            <div class="text-zinc-500 text-[10px]">
              {{ s.documentCount }} docs
            </div>
          </div>
        </div>
        <div
          v-if="selectedMemorySpaces.length > 6"
          class="text-zinc-500 text-[10px] mt-1"
        >
          +{{ selectedMemorySpaces.length - 6 }} more
        </div>
      </template>
      <div
        v-else
        class="text-zinc-500"
      >
        No memory spaces selected
      </div>
      <div class="text-zinc-600 text-[10px] mt-1.5 border-t border-zinc-800 pt-1.5">
        Click to configure
      </div>
    </template>
  </HoverTooltip>

  <MemorySpaceSelectorModal v-model="showModal" />
</template>
