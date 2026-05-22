<script setup lang="ts">
import { computed } from 'vue'
import { Icon } from '@iconify/vue'
import { useAgentStore } from '../../stores/agent-runtime.store'
import type { OrchestrationTaskItem, OrchestrationTaskStatus } from '../../api/types'

const agentStore = useAgentStore()

const state = computed(() => agentStore.orchestrationState)
const shouldShow = computed(() => Boolean(state.value?.items.length))
const completedCount = computed(() => state.value?.items.filter((item) => item.status === 'completed').length ?? 0)
const totalCount = computed(() => state.value?.items.length ?? 0)

const visibleItems = computed(() => {
  const items = state.value?.items ?? []
  if (items.length <= 7) return items

  const active = items.filter((item) => item.status !== 'completed')
  const completed = items.filter((item) => item.status === 'completed')
  return [...active, ...completed.slice(Math.max(0, completed.length - Math.max(0, 7 - active.length)))]
})

const hiddenCompletedCount = computed(() => {
  const items = state.value?.items ?? []
  if (items.length <= 7) return 0
  const visibleIds = new Set(visibleItems.value.map((item) => item.id))
  return items.filter((item) => item.status === 'completed' && !visibleIds.has(item.id)).length
})

const statusMeta: Record<OrchestrationTaskStatus, { icon: string; cls: string }> = {
  pending: { icon: 'lucide:circle', cls: 'text-theme-500' },
  in_progress: { icon: 'svg-spinners:ring-resize', cls: 'text-accent-400' },
  completed: { icon: 'lucide:check-circle-2', cls: 'text-emerald-400' },
  blocked: { icon: 'lucide:octagon-alert', cls: 'text-amber-400' },
  cancelled: { icon: 'lucide:circle-x', cls: 'text-theme-500' },
}

function itemClass(item: OrchestrationTaskItem): string {
  if (item.status === 'completed') return 'text-theme-400'
  if (item.status === 'blocked') return 'text-amber-200'
  if (item.status === 'cancelled') return 'text-theme-500'
  return 'text-theme-200'
}
</script>

<template>
  <div
    v-if="shouldShow && state"
    class="border-t border-theme-800 bg-theme-900/95 px-4 py-2"
  >
    <div class="max-w-5xl mx-auto rounded-lg border border-theme-800 bg-theme-950/60 px-3 py-2">
      <div class="h-7 flex items-center gap-3 min-w-0">
        <Icon
          icon="lucide:list-checks"
          class="w-4 h-4 text-accent-400 shrink-0"
        />
        <div class="min-w-0 flex-1">
          <div class="text-xs font-medium text-theme-200 truncate">
            {{ state.objective }}
          </div>
        </div>
        <div class="text-[11px] text-theme-500 shrink-0">
          {{ completedCount }}/{{ totalCount }}
        </div>
      </div>

      <div class="mt-1 grid gap-1">
        <div
          v-for="item in visibleItems"
          :key="item.id"
          class="h-8 flex items-center gap-2 min-w-0 rounded-md px-1"
        >
          <Icon
            :icon="statusMeta[item.status].icon"
            class="w-3.5 h-3.5 shrink-0"
            :class="statusMeta[item.status].cls"
          />
          <span
            class="text-xs truncate min-w-0"
            :class="itemClass(item)"
          >
            {{ item.title }}
          </span>
          <span
            v-if="item.note"
            class="text-[11px] text-theme-500 truncate min-w-0 hidden sm:block"
          >
            {{ item.note }}
          </span>
        </div>

        <div
          v-if="hiddenCompletedCount > 0"
          class="h-6 flex items-center gap-2 px-1 text-[11px] text-theme-500"
        >
          <Icon
            icon="lucide:ellipsis"
            class="w-3.5 h-3.5"
          />
          <span>{{ hiddenCompletedCount }} completed hidden</span>
        </div>
      </div>
    </div>
  </div>
</template>
