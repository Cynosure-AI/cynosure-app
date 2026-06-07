<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useChatStore } from '../../../stores/chat.store'
import { Icon } from '@iconify/vue'
import HoverTooltip from '../../shared/HoverTooltip.vue'
import MemorySpaceSelectorModal from '../modals/MemorySpaceSelectorModal.vue'

const chatStore = useChatStore()

const showModal = ref(false)

onMounted(() => chatStore.loadMemorySpaces())

const selectedMemorySpaces = computed(() => {
  const ids = chatStore.freeChatMemorySpaceIds
  return chatStore.memorySpaces.filter(s => ids.includes(s.id))
})

const memorySpaceCount = computed(() => selectedMemorySpaces.value.length)
const autoMemoryEnabled = computed(() => chatStore.sessionAutoMemory === true)
</script>

<template>
  <HoverTooltip :max-width="260">
    <button
      class="relative p-2.5 rounded-xl transition-colors shrink-0 focus:outline-none focus:ring-1 focus:ring-accent-500 text-theme-500 hover:text-theme-300"
      aria-label="Memory folders"
      @click="showModal = true"
    >
      <Icon
        icon="lucide:brain"
        class="h-5 w-5"
        :class="{ 'text-emerald-600': chatStore.sessionAutoMemory === true }"
      />
      <span
        v-if="autoMemoryEnabled || memorySpaceCount > 0"
        class="absolute -top-0.5 -right-0.5 min-w-4 h-4 flex items-center justify-center rounded-full text-[9px] font-bold text-white px-1 leading-none"
        :class="autoMemoryEnabled ? 'bg-emerald-600' : 'bg-accent-600'"
      >
        <Icon
          v-if="autoMemoryEnabled && memorySpaceCount === 1 && selectedMemorySpaces[0].isDefault"
          icon="lucide:sparkles"
          class="w-2.5 h-2.5"
        />
        <template v-else>
          {{ memorySpaceCount }}
        </template>
      </span>
    </button>
    <template #content>
      <div class="font-medium text-theme-300 mb-1.5">
        Memory Folders ({{ memorySpaceCount }} selected)
      </div>
      <div
        v-if="autoMemoryEnabled"
        class="mb-1.5 px-1 py-1 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-[10px]"
      >
        Auto-selection enabled
      </div>
      <div
        v-else
        class="flex items-center gap-1.5 text-[11px] mb-1.5 text-theme-500"
      >
        <Icon
          icon="lucide:brain-circuit"
          class="w-3 h-3"
        />
        Auto Memories off
      </div>
      <template v-if="selectedMemorySpaces.length">
        <div
          v-for="s in selectedMemorySpaces.slice(0, 6)"
          :key="s.id"
          class="flex items-start gap-1.5 mb-1 last:mb-0"
        >
          <Icon
            icon="lucide:folder"
            class="w-3 h-3 text-purple-400 shrink-0 mt-0.5"
          />
          <div class="min-w-0">
            <div class="text-theme-300 text-[11px] truncate">
              {{ s.name }}
            </div>
            <div class="text-theme-500 text-[10px]">
              {{ s.fileCount }} docs
            </div>
          </div>
        </div>
        <div
          v-if="selectedMemorySpaces.length > 6"
          class="text-theme-500 text-[10px] mt-1"
        >
          +{{ selectedMemorySpaces.length - 6 }} more
        </div>
      </template>
      <div
        v-else
        class="text-theme-500"
      >
        No memory folders selected
      </div>
      <div class="text-theme-600 text-[10px] mt-1.5 border-t border-theme-800 pt-1.5">
        Click to configure
      </div>
    </template>
  </HoverTooltip>

  <MemorySpaceSelectorModal v-model="showModal" />
</template>
