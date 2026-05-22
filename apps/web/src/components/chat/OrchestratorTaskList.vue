<script setup lang="ts">
import { computed, ref } from 'vue'
import { Icon } from '@iconify/vue'
import { useAgentStore } from '../../stores/agent-runtime.store'
import type { OrchestrationTaskItem, OrchestrationTaskStatus } from '../../api/types'

const agentStore = useAgentStore()
const collapsed = ref(false)

const state = computed(() => agentStore.orchestrationState)
const shouldShow = computed(() => Boolean(state.value?.items.length))
const completedCount = computed(() => state.value?.items.filter((item) => item.status === 'completed').length ?? 0)
const totalCount = computed(() => state.value?.items.length ?? 0)
const activeTask = computed(() => state.value?.items.find((item) => item.status === 'in_progress') ?? null)

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
      <button
        type="button"
        class="h-7 w-full flex items-center gap-3 min-w-0 rounded-md text-left hover:bg-theme-900/60 transition-colors"
        :title="collapsed ? 'Show tasks' : 'Hide tasks'"
        :aria-label="collapsed ? 'Show tasks' : 'Hide tasks'"
        :aria-expanded="!collapsed"
        @click="collapsed = !collapsed"
      >
        <span
          class="h-6 w-6 flex items-center justify-center rounded-md text-accent-400 shrink-0"
          :title="collapsed ? 'Show tasks' : 'Hide tasks'"
        >
          <Icon
            icon="lucide:list-checks"
            class="w-4 h-4"
          />
        </span>
        <div class="min-w-0 flex-1">
          <div class="text-xs font-medium text-theme-200 truncate">
            Tasks {{ completedCount }}/{{ totalCount }}
            <span class="text-theme-500 font-normal"> - {{ state.objective }}</span>
          </div>
          <div
            v-if="collapsed && activeTask"
            class="flex items-center gap-1.5 mt-0.5"
          >
            <Icon
              :icon="statusMeta[activeTask.status].icon"
              class="w-3 h-3 shrink-0"
              :class="statusMeta[activeTask.status].cls"
            />
            <span class="text-[11px] text-theme-300 truncate">
              {{ activeTask.title }}
            </span>
          </div>
        </div>
        <span class="h-6 w-6 flex items-center justify-center rounded-md text-theme-500 shrink-0">
          <Icon
            icon="lucide:chevron-down"
            class="w-3.5 h-3.5 transition-transform"
            :class="{ '-rotate-90': collapsed }"
          />
        </span>
      </button>

      <div
        v-if="!collapsed"
        class="mt-1 grid gap-1 overflow-y-auto pr-1"
        style="max-height: min(18rem, 34vh);"
      >
        <div
          v-for="item in state.items"
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
      </div>
    </div>
  </div>
</template>
