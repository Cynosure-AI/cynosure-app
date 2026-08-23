<script setup lang="ts">
import { computed, ref } from 'vue'
import McpSettings from '../../components/settings/mcp/McpSettings.vue'
import TabBar, { type TabDef } from '../../components/shared/TabBar.vue'
import { useMcpServers } from '../../composables/useMcpServers'

type McpPanel = 'installed' | 'browse'

const sections = [
  {
    id: 'installed',
    label: 'Installed',
    description: 'Connect and manage Model Context Protocol servers that add external tools to your agents.',
    icon: 'lucide:plug',
  },
  {
    id: 'browse',
    label: 'Browse Registry',
    description: 'Discover and install MCP servers from recommended and public registries.',
    icon: 'lucide:search',
  },
] as const

const { servers } = useMcpServers()
const activePanel = ref<McpPanel>('installed')
const activeSection = computed(() => sections.find((section) => section.id === activePanel.value) || sections[0])
const tabs = computed<TabDef<McpPanel>[]>(() => sections.map((section) => ({
  value: section.id,
  label: section.label,
  icon: section.icon,
  badge: section.id === 'installed' ? servers.value.length || undefined : undefined,
})))
</script>

<template>
  <div class="h-full overflow-y-auto">
    <header class="sticky top-0 z-10 border-b border-theme-800/60 bg-theme-950/95 px-5 pt-5 backdrop-blur-sm md:px-8 md:pt-6">
      <div class="mx-auto max-w-7xl">
        <h1 class="text-2xl font-bold text-theme-100">
          MCP Servers
        </h1>
        <p class="mt-1 text-sm leading-relaxed text-theme-500">
          {{ activeSection.description }}
        </p>
      </div>

      <TabBar
        v-model="activePanel"
        :tabs="tabs"
        class="mx-auto mt-4 max-w-7xl"
      />
    </header>

    <div class="mx-auto max-w-7xl px-5 py-6 md:px-8">
      <McpSettings v-model="activePanel" />
    </div>
  </div>
</template>
