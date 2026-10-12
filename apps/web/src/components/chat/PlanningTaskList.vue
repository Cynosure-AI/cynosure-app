<script setup lang="ts">
import { computed } from 'vue'
import { Icon } from '@iconify/vue'
import { useAgentStore } from '../../stores/agent-runtime.store'
import type { PlanningTaskItem, PlanningTaskStatus } from '../../api/types'

const agentStore = useAgentStore()
defineEmits<{ close: [] }>()

const state = computed(() => agentStore.planningState)
const shouldShow = computed(() => Boolean(state.value?.items.length))
const completedCount = computed(() => state.value?.items.filter((item) => item.status === 'completed').length ?? 0)
const totalCount = computed(() => state.value?.items.length ?? 0)

const statusMeta: Record<PlanningTaskStatus, { icon: string; cls: string }> = {
  pending: { icon: 'lucide:circle', cls: 'text-ink-muted' },
  in_progress: { icon: 'svg-spinners:ring-resize', cls: 'text-accent-fg' },
  completed: { icon: 'lucide:check-circle-2', cls: 'text-status-success' },
  blocked: { icon: 'lucide:octagon-alert', cls: 'text-status-warning' },
  cancelled: { icon: 'lucide:circle-x', cls: 'text-ink-muted' },
}

function itemClass(item: PlanningTaskItem): string {
  if (item.status === 'completed') return 'text-ink-secondary'
  if (item.status === 'blocked') return 'text-amber-200'
  if (item.status === 'cancelled') return 'text-ink-muted'
  return 'text-theme-200'
}
</script>

<template>
  <div
    v-if="shouldShow && state"
    role="dialog"
    aria-label="Planning tasks"
    class="planning-task-panel absolute right-3 top-3 z-20 flex max-h-[min(24rem,calc(100%_-_1.5rem))] w-[min(24rem,calc(100%_-_1.5rem))] flex-col overflow-hidden rounded-xl border border-theme-700 bg-theme-950/95 shadow-2xl shadow-black/40 backdrop-blur"
  >
    <div class="flex min-w-0 items-center gap-3 border-b border-theme-800 px-3 py-2.5">
      <span class="h-6 w-6 flex items-center justify-center rounded-md text-accent-fg shrink-0">
        <Icon
          icon="lucide:list-checks"
          class="w-4 h-4"
        />
      </span>
      <div class="min-w-0 flex-1">
        <div class="truncate text-xs font-medium text-theme-200">
          Tasks {{ completedCount }}/{{ totalCount }}
          <span class="font-normal text-ink-muted"> · {{ state.objective }}</span>
        </div>
      </div>
      <button
        type="button"
        class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-theme-800 hover:text-theme-200"
        title="Close tasks"
        aria-label="Close tasks"
        @click="$emit('close')"
      >
        <Icon
          icon="lucide:x"
          class="h-3.5 w-3.5"
        />
      </button>
    </div>

    <div class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
      <div
        v-for="item in state.items"
        :key="item.id"
        class="group flex min-w-0 items-start gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-theme-900/60"
        :title="item.note ? `${item.title} — ${item.note}` : item.title"
      >
        <Icon
          :icon="statusMeta[item.status].icon"
          class="mt-0.5 h-3.5 w-3.5 shrink-0"
          :class="statusMeta[item.status].cls"
        />

        <div class="min-w-0 flex-1">
          <div
            class="line-clamp-2 text-xs font-medium leading-[1.35]"
            :class="itemClass(item)"
          >
            {{ item.title }}
          </div>

          <div
            v-if="item.note"
            class="mt-1 line-clamp-2 whitespace-pre-line text-[11px] leading-[1.4] text-ink-muted"
          >
            {{ item.note }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
