<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useChatStore } from '../../../stores/chat.store'
import { Icon } from '@iconify/vue'
import HoverTooltip from '../../shared/HoverTooltip.vue'
import MemoryFolderSelectorPopover from './MemoryFolderSelectorPopover.vue'
import { isMemoryFolderSelected } from '../../../utils/memory-folder-selection'

const chatStore = useChatStore()

onMounted(() => chatStore.loadMemoryFolders())

const selectedMemoryFolders = computed(() => {
  const ids = chatStore.freeChatMemoryFolderIds
  return chatStore.memoryFolders.filter(s => ids.includes(s.id))
})

const rootSelected = computed(() => selectedMemoryFolders.value.some(folder => folder.isUncategorized))
const memoryFolderCount = computed(() => {
  const selectedIds = new Set(chatStore.freeChatMemoryFolderIds)
  return chatStore.memoryFolders.filter((folder) => isMemoryFolderSelected(folder, selectedIds, rootSelected.value)).length
})
const autoMemoryEnabled = computed(() => chatStore.sessionAutoMemory === true)
</script>

<template>
  <MemoryFolderSelectorPopover>
    <template #trigger="{ open, toggle }">
      <HoverTooltip
        :max-width="260"
        :disabled="open"
      >
        <button
          type="button"
          class="relative p-2.5 rounded-xl transition-colors shrink-0 focus:outline-none focus:ring-1 focus:ring-accent-500"
          :class="open ? 'bg-theme-700/50 text-accent-400' : 'text-theme-500 hover:text-theme-300'"
          aria-label="Memory folders"
          aria-haspopup="menu"
          :aria-expanded="open"
          @click="toggle"
        >
          <Icon
            icon="lucide:brain"
            class="h-5 w-5"
            :class="{ 'text-emerald-600': chatStore.sessionAutoMemory === true }"
          />
          <span
            v-if="autoMemoryEnabled || memoryFolderCount > 0"
            class="absolute -top-0.5 -right-0.5 min-w-4 h-4 flex items-center justify-center rounded-full text-[9px] font-bold text-white px-1 leading-none"
            :class="autoMemoryEnabled ? 'bg-emerald-600' : 'bg-accent-600'"
          >
            <Icon
              v-if="rootSelected"
              icon="lucide:layers-3"
              class="w-2.5 h-2.5"
            />
            <template v-else>
              {{ memoryFolderCount }}
            </template>
          </span>
        </button>
        <template #content>
          <div class="font-medium text-theme-300 mb-1.5">
            {{ rootSelected ? 'Default Memory selected' : `Memory Folders (${memoryFolderCount} selected)` }}
          </div>
          <div
            v-if="autoMemoryEnabled"
            class="mb-1.5 rounded border border-emerald-200 bg-emerald-50 px-1 py-1 text-[10px] font-medium text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300"
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
            Automatic retrieval off
          </div>
          <template v-if="selectedMemoryFolders.length">
            <div
              v-for="s in selectedMemoryFolders.slice(0, 6)"
              :key="s.id"
              class="flex items-start gap-1.5 mb-1 last:mb-0"
            >
              <Icon
                icon="lucide:folder"
                class="w-3 h-3 text-purple-400 shrink-0 mt-0.5"
              />
              <div class="min-w-0">
                <div class="text-theme-300 text-[11px] truncate">
                  {{ s.isUncategorized ? 'All Memory' : s.name }}
                </div>
                <div class="text-theme-500 text-[10px]">
                  {{ s.isUncategorized ? 'Includes Uncategorized and standard folders' : `${s.fileCount} docs` }}
                </div>
              </div>
            </div>
            <div
              v-if="selectedMemoryFolders.length > 6"
              class="text-theme-500 text-[10px] mt-1"
            >
              +{{ selectedMemoryFolders.length - 6 }} more
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
    </template>
  </MemoryFolderSelectorPopover>
</template>
