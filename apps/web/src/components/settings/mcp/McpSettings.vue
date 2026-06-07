<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { api } from '../../../api/client'
import TabBar, { type TabDef } from '../../shared/TabBar.vue'
import { useMcpServers } from '../../../composables/useMcpServers'
import McpBrowseTab from './McpBrowseTab.vue'
import McpInstalledTab from './McpInstalledTab.vue'

const { servers, actionError, authInProgress, loadServers, refreshAll } = useMcpServers()

type McpTab = 'browse' | 'installed'
const activeTab = ref<McpTab>('installed')

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
  )
})

onUnmounted(() => {
  cleanups.forEach((fn) => fn())
})
</script>

<template>
  <div>
    <!-- Tabs -->
    <TabBar
      v-model="activeTab"
      :tabs="[
        { value: 'installed', label: 'Installed', icon: 'lucide:plug', badge: servers.length || undefined } as TabDef<McpTab>,
        { value: 'browse', label: 'Browse Registry', icon: 'lucide:search' } as TabDef<McpTab>,
      ]"
      class="mb-5"
    />

    <McpBrowseTab
      v-if="activeTab === 'browse'"
      @go-to-installed="activeTab = 'installed'"
    />
    <McpInstalledTab
      v-else-if="activeTab === 'installed'"
      @go-to-browse="activeTab = 'browse'"
    />
  </div>
</template>
