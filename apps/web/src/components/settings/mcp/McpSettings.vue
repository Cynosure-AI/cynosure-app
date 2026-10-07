<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { api } from '../../../api/client'
import { useMcpServers } from '../../../composables/useMcpServers'
import McpBrowseTab from './McpBrowseTab.vue'
import McpInstalledTab from './McpInstalledTab.vue'

const { actionError, authInProgress, loadServers, refreshAll } = useMcpServers()

type McpTab = 'browse' | 'installed'

const props = defineProps<{
  modelValue: McpTab
}>()

const emit = defineEmits<{
  'update:modelValue': [value: McpTab]
}>()

const cleanups: (() => void)[] = []

onMounted(() => {
  loadServers()

  // Auto-refresh when background OAuth completes
  cleanups.push(
    api.mcp.onAuthComplete(async (data) => {
      if (authInProgress.value === data.serverId) {
        authInProgress.value = null
      }
      delete actionError.value[data.serverId]
      await refreshAll()
    }),
    // Background disconnects, automatic reconnects and tool list changes
    api.mcp.onServerStatus(async (data) => {
      if (data.connected) delete actionError.value[data.serverId]
      await refreshAll()
    }),
  )
})

onUnmounted(() => {
  cleanups.forEach((fn) => fn())
})
</script>

<template>
  <div>
    <McpBrowseTab
      v-if="props.modelValue === 'browse'"
      @go-to-installed="emit('update:modelValue', 'installed')"
    />
    <McpInstalledTab
      v-else
      @go-to-browse="emit('update:modelValue', 'browse')"
    />
  </div>
</template>
