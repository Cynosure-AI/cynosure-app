<script setup lang="ts">
import { ref, watch } from 'vue'
import { useChatStore } from '../../stores/chat.store'
import { api, type MemorySpace } from '../../api/client'
import { Icon } from '@iconify/vue'

const chatStore = useChatStore()

const visible = defineModel<boolean>({ required: true })

const spaces = ref<MemorySpace[]>([])
const loading = ref(false)

watch(visible, async (val) => {
  if (!val) return
  loading.value = true
  try {
    spaces.value = await api.memorySpaces.list()
  } catch { /* ignore */ }
  loading.value = false
})

const selected = chatStore.freeChatMemorySpaceIds

function toggle(id: string) {
  const idx = selected.indexOf(id)
  if (idx >= 0) {
    selected.splice(idx, 1)
  } else {
    selected.push(id)
  }
  chatStore.markOverridesModified()
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      @click.self="visible = false"
    >
      <div class="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-105 max-h-[70vh] flex flex-col">
        <!-- Header -->
        <div class="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <h3 class="text-sm font-semibold text-zinc-200">
            Memory Spaces
          </h3>
          <button
            class="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
            @click="visible = false"
          >
            <Icon
              icon="mdi:close"
              class="h-4 w-4"
            />
          </button>
        </div>

        <!-- Space list -->
        <div class="overflow-y-auto p-2 space-y-1">
          <div
            v-if="loading"
            class="text-sm text-zinc-500 text-center py-6"
          >
            Loading…
          </div>
          <div
            v-else-if="spaces.length === 0"
            class="text-sm text-zinc-500 text-center py-6"
          >
            No memory spaces created yet
          </div>
          <button
            v-for="space in spaces"
            :key="space.id"
            class="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg transition-colors text-left"
            :class="selected.includes(space.id)
              ? 'bg-blue-600/15 border border-blue-500/30'
              : 'hover:bg-zinc-800 border border-transparent'"
            @click="toggle(space.id)"
          >
            <div class="w-7 h-7 rounded-lg bg-zinc-800 flex items-center justify-center shrink-0">
              <Icon
                icon="lucide:brain"
                class="w-3.5 h-3.5"
                :class="selected.includes(space.id) ? 'text-blue-400' : 'text-zinc-500'"
              />
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-sm text-zinc-200 truncate">
                {{ space.name }}
              </div>
              <div class="text-[11px] text-zinc-500">
                {{ space.documentCount }} document{{ space.documentCount !== 1 ? 's' : '' }}
              </div>
            </div>
            <Icon
              v-if="selected.includes(space.id)"
              icon="mdi:check-circle"
              class="w-4 h-4 text-blue-400 shrink-0"
            />
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
