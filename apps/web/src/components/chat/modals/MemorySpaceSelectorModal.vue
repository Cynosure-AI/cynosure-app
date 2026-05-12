<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useChatStore } from '../../../stores/chat.store'
import { api } from '../../../api/client'
import type { MemorySpace } from '../../../api/types'
import { Icon } from '@iconify/vue'
import ModalDialog from '../../shared/ModalDialog.vue'

const chatStore = useChatStore()

const visible = defineModel<boolean>({ required: true })

const spaces = ref<MemorySpace[]>([])
const loading = ref(false)

watch(visible, async (val) => {
  if (!val) return
  loading.value = true
  try {
    spaces.value = await api.memorySpaces.list()

    const validIds = new Set(spaces.value.map((space) => space.id))
    const nextSelected = chatStore.freeChatMemorySpaceIds.filter((id) => validIds.has(id))
    if (nextSelected.length !== chatStore.freeChatMemorySpaceIds.length) {
      chatStore.freeChatMemorySpaceIds.splice(
        0,
        chatStore.freeChatMemorySpaceIds.length,
        ...nextSelected,
      )
      chatStore.markOverridesModified()
    }
  } catch { /* ignore */ }
  loading.value = false
})

const selected = computed(() => chatStore.freeChatMemorySpaceIds)

function toggle(id: string) {
  const idx = chatStore.freeChatMemorySpaceIds.indexOf(id)
  if (idx >= 0) {
    chatStore.freeChatMemorySpaceIds.splice(idx, 1)
  } else {
    chatStore.freeChatMemorySpaceIds.push(id)
  }
  chatStore.markOverridesModified()
}
</script>

<template>
  <ModalDialog
    :show="visible"
    title="Memory Spaces"
    icon="lucide:brain"
    icon-color="accent"
    max-width="max-w-sm"
    @close="visible = false"
  >
    <!-- Space list -->
    <div class="overflow-y-auto space-y-1 max-h-80">
      <div
        v-if="loading"
        class="text-sm text-theme-500 text-center py-6"
      >
        Loading…
      </div>
      <div
        v-else-if="spaces.length === 0"
        class="text-sm text-theme-500 text-center py-6"
      >
        No memory spaces created yet
      </div>
      <button
        v-for="space in spaces"
        :key="space.id"
        class="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg transition-colors text-left"
        :class="selected.includes(space.id)
          ? 'bg-accent-600/15 border border-accent-500/30'
          : 'hover:bg-theme-800 border border-transparent'"
        @click="toggle(space.id)"
      >
        <div class="w-7 h-7 rounded-lg bg-theme-800 flex items-center justify-center shrink-0">
          <Icon
            icon="lucide:brain"
            class="w-3.5 h-3.5"
            :class="selected.includes(space.id) ? 'text-accent-400' : 'text-theme-500'"
          />
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-sm text-theme-200 truncate">
            {{ space.name }}
          </div>
          <div class="text-[11px] text-theme-500">
            {{ space.fileCount }} document{{ space.fileCount !== 1 ? 's' : '' }}
          </div>
        </div>
        <Icon
          v-if="selected.includes(space.id)"
          icon="mdi:check-circle"
          class="w-4 h-4 text-accent-400 shrink-0"
        />
      </button>
    </div>
  </ModalDialog>
</template>
