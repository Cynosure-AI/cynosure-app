<script setup lang="ts">
import { computed } from 'vue'
import { Icon } from '@iconify/vue'
import type { McpStartupServer, ServerStartupProgress } from '@shared/types'
import { useServerStartupError } from '../../composables/useServerStartupError'

const PHASES: ServerStartupProgress['phase'][] = ['providers', 'memory', 'tools', 'conversations', 'folders', 'mcp', 'channels', 'ready']
// Connecting servers only show their timer once they start to feel slow.
const SLOW_MS = 3000

const { startupProgress } = useServerStartupError()
const servers = computed(() => startupProgress.value?.mcpServers ?? [])
const finished = computed(() => servers.value.filter(server => server.status !== 'connecting').length)
const counts = computed(() => {
  const result = { connected: 0, 'auth-required': 0, error: 0 }
  for (const server of servers.value) if (server.status !== 'connecting') result[server.status]++
  return result
})
const summary = computed(() => [
  counts.value.connected && `${counts.value.connected} connected`,
  counts.value['auth-required'] && `${counts.value['auth-required']} need${counts.value['auth-required'] === 1 ? 's' : ''} auth`,
  counts.value.error && `${counts.value.error} failed`,
].filter(Boolean).join(' · '))
// Each phase gets an equal slice of the bar; the MCP slice fills as servers finish.
const percent = computed(() => {
  const progress = startupProgress.value
  if (!progress) return 0
  const index = PHASES.indexOf(progress.phase)
  const within = progress.phase === 'mcp' && servers.value.length ? finished.value / servers.value.length : 0
  return Math.min(100, ((index + within) / (PHASES.length - 1)) * 100)
})

const statusMeta: Record<McpStartupServer['status'], { label: string; icon: string; class: string }> = {
  connecting: { label: 'Connecting', icon: 'lucide:loader-2', class: 'border-theme-700/70 text-ink-muted' },
  connected: { label: 'Connected', icon: 'lucide:check', class: 'border-status-success/25 bg-status-success/5 text-theme-200' },
  'auth-required': { label: 'Authorization needed', icon: 'lucide:key-round', class: 'border-status-warning/40 bg-status-warning/10 text-theme-200' },
  error: { label: 'Could not connect', icon: 'lucide:circle-x', class: 'border-status-danger/40 bg-status-danger/10 text-theme-200' },
}
const iconClass: Record<McpStartupServer['status'], string> = {
  connecting: 'animate-spin motion-reduce:animate-none text-accent-fg',
  connected: 'text-status-success',
  'auth-required': 'text-status-warning',
  error: 'text-status-danger',
}
function seconds(ms: number): string {
  return `${Math.floor(ms / 1000)}s`
}
function chipTitle(server: McpStartupServer): string {
  const tools = server.toolCount ? ` · ${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}` : ''
  return `${server.name}\n${statusMeta[server.status].label} · ${seconds(server.elapsedMs)}${tools}`
}
</script>

<template>
  <div class="chat-intro-fade mt-3 w-full max-w-lg text-sm text-ink-muted">
    <div class="flex items-baseline justify-between gap-3">
      <p
        role="status"
        aria-live="polite"
        class="min-w-0 truncate"
      >
        {{ startupProgress?.message ?? 'Connecting to server…' }}
      </p>
      <span
        v-if="startupProgress?.phase === 'mcp' && servers.length"
        class="shrink-0 text-xs tabular-nums text-ink-faint"
        data-testid="startup-count"
      >{{ finished }}/{{ servers.length }}</span>
    </div>
    <div
      class="startup-track relative mt-2 h-1 overflow-hidden rounded-full bg-theme-800"
      role="progressbar"
      aria-label="Startup progress"
      :aria-valuenow="Math.round(percent)"
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <div
        class="startup-fill h-full rounded-full bg-accent-500 transition-[width] duration-500 ease-out"
        :style="{ width: `${Math.max(percent, 4)}%` }"
      />
    </div>
    <ul
      v-if="servers.length"
      aria-label="MCP server startup status"
      class="mt-4 flex flex-wrap justify-center gap-1.5 text-xs"
    >
      <li
        v-for="server in servers"
        :key="server.id"
        class="inline-flex max-w-[12rem] items-center gap-1.5 rounded-full border px-2.5 py-1 transition-colors duration-300"
        :class="statusMeta[server.status].class"
        :title="chipTitle(server)"
      >
        <Icon
          :icon="statusMeta[server.status].icon"
          class="h-3 w-3 shrink-0"
          :class="iconClass[server.status]"
          aria-hidden="true"
        />
        <span class="min-w-0 truncate">{{ server.name }}</span>
        <span class="sr-only">{{ statusMeta[server.status].label }}</span>
        <span
          v-if="server.status === 'connecting' && server.elapsedMs >= SLOW_MS"
          class="shrink-0 tabular-nums text-ink-faint"
        >{{ seconds(server.elapsedMs) }}</span>
      </li>
    </ul>
    <p
      v-if="startupProgress"
      class="mt-4 text-center text-xs tabular-nums text-ink-faint"
    >
      <span v-if="summary">{{ summary }} · </span>{{ seconds(startupProgress.elapsedMs) }}
    </p>
  </div>
</template>

<style scoped>
/* A soft highlight sweeps across the filled part so the bar reads as alive between updates. */
.startup-fill {
  background-image: linear-gradient(90deg, transparent, color-mix(in srgb, white 35%, transparent), transparent);
  background-size: 200% 100%;
  background-repeat: no-repeat;
  animation: startup-sweep 1.6s ease-in-out infinite;
}

@keyframes startup-sweep {
  from { background-position: 200% 0; }
  to { background-position: -100% 0; }
}

@media (prefers-reduced-motion: reduce) {
  .startup-fill { animation: none; }
}
</style>
