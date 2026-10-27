<script setup lang="ts">
import { computed } from 'vue'
import { Icon } from '@iconify/vue'
import type { ServerStartupProgress } from '@shared/types'
import { useServerStartupError } from '../../composables/useServerStartupError'

const PHASES: ServerStartupProgress['phase'][] = ['providers', 'memory', 'tools', 'conversations', 'folders', 'mcp', 'channels', 'ready']
// The waiting line only shows a timer once startup starts to feel slow.
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

// Connected servers are the expected outcome, so only pending and problem servers get named.
const pending = computed(() => servers.value.filter(server => server.status === 'connecting'))
const issues = computed(() => servers.value.filter(server => server.status === 'auth-required' || server.status === 'error'))
// Name a couple of the servers still being waited on; the rest collapse into "+N".
const WAITING_NAMES = 2
const waitingOn = computed(() => {
  const list = pending.value
  if (!list.length) return ''
  const names = list.slice(0, WAITING_NAMES).map(server => server.name).join(', ')
  return list.length > WAITING_NAMES ? `${names} +${list.length - WAITING_NAMES}` : names
})
const waitingTitle = computed(() => pending.value.map(server => `${server.name} · ${seconds(server.elapsedMs)}`).join('\n'))
const slowestPending = computed(() => Math.max(0, ...pending.value.map(server => server.elapsedMs)))

const issueMeta: Record<'auth-required' | 'error', { label: string; icon: string; iconClass: string }> = {
  'auth-required': { label: 'needs authorization', icon: 'lucide:key-round', iconClass: 'text-status-warning' },
  error: { label: 'could not connect', icon: 'lucide:circle-x', iconClass: 'text-status-danger' },
}
function seconds(ms: number): string {
  return `${Math.floor(ms / 1000)}s`
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
    <p
      v-if="startupProgress?.phase === 'mcp' && waitingOn"
      class="mt-2 flex items-center gap-1.5 text-xs text-ink-faint"
      :title="waitingTitle"
      data-testid="startup-waiting"
    >
      <Icon
        icon="lucide:loader-2"
        class="h-3 w-3 shrink-0 animate-spin text-accent-fg motion-reduce:animate-none"
        aria-hidden="true"
      />
      <span class="min-w-0 truncate">Waiting on {{ waitingOn }}</span>
      <span
        v-if="slowestPending >= SLOW_MS"
        class="ml-auto shrink-0 tabular-nums"
      >{{ seconds(slowestPending) }}</span>
    </p>
    <ul
      v-if="issues.length"
      aria-label="MCP servers needing attention"
      class="mt-3 space-y-1 text-xs"
    >
      <li
        v-for="server in issues"
        :key="server.id"
        class="flex items-center gap-1.5"
      >
        <Icon
          :icon="issueMeta[server.status as keyof typeof issueMeta].icon"
          class="h-3 w-3 shrink-0"
          :class="issueMeta[server.status as keyof typeof issueMeta].iconClass"
          aria-hidden="true"
        />
        <span class="min-w-0 truncate text-theme-200">{{ server.name }}</span>
        <span class="shrink-0 text-ink-faint">{{ issueMeta[server.status as keyof typeof issueMeta].label }}</span>
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
