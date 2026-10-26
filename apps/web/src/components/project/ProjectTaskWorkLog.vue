<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import { api } from '../../api/client'
import type { PlanningState } from '../../api/types'
import { PLANNING_ITEM_STATUS, PLANNING_RUN_STATUS } from '../../utils/planning-status'
import { formatRelativeTime } from '../../utils/project-format'

const props = defineProps<{ projectId: string; taskId: string }>()

const plans = ref<PlanningState[]>([])
const loaded = ref(false)
const error = ref('')
const cleanups: Array<() => void> = []
let refreshTimer: ReturnType<typeof setTimeout> | null = null

async function load(): Promise<void> {
  try {
    plans.value = await api.projects.taskWorkLog(props.projectId, props.taskId)
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loaded.value = true
  }
}

function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => { void load() }, 250)
}

function completedCount(plan: PlanningState): number {
  return plan.items.filter((item) => item.status === 'completed').length
}

watch(() => [props.projectId, props.taskId], () => {
  loaded.value = false
  plans.value = []
  void load()
})

onMounted(() => {
  cleanups.push(
    // A status change links the running plan to the task; step updates change a plan already in the log.
    api.projects.onTasksUpdated(({ projectId }) => { if (projectId === props.projectId) scheduleRefresh() }),
    api.agent.onPlanningStateUpdated((data) => {
      const runId = (data as Partial<PlanningState> | null)?.runId
      if (runId && plans.value.some((plan) => plan.runId === runId)) scheduleRefresh()
    }),
  )
  void load()
})

onBeforeUnmount(() => {
  if (refreshTimer) clearTimeout(refreshTimer)
  cleanups.forEach((cleanup) => cleanup())
})
</script>

<template>
  <section
    aria-label="Work log"
    class="border-t border-theme-800 pt-4"
  >
    <h3 class="mb-3 flex items-center gap-2 text-sm font-medium text-ink-secondary">
      <Icon
        icon="lucide:history"
        class="h-4 w-4"
      />
      Work log
      <span
        v-if="plans.length"
        class="rounded bg-theme-800 px-1.5 py-0.5 text-[10px] font-medium"
      >{{ plans.length }}</span>
    </h3>

    <p
      v-if="error"
      role="alert"
      class="text-xs text-status-danger"
    >
      {{ error }}
    </p>
    <p
      v-else-if="loaded && !plans.length"
      class="text-xs text-ink-faint"
    >
      When an agent works on this task, its step plan is recorded here.
    </p>

    <ol
      v-else
      class="flex flex-col gap-2"
    >
      <li
        v-for="(plan, index) in plans"
        :key="plan.runId"
      >
        <details
          class="group rounded-lg border border-theme-800 bg-theme-900/60"
          :open="index === 0"
        >
          <summary class="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2.5 text-xs [&::-webkit-details-marker]:hidden">
            <Icon
              icon="lucide:chevron-right"
              class="h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform group-open:rotate-90"
            />
            <span
              class="shrink-0 font-medium"
              :class="PLANNING_RUN_STATUS[plan.status].cls"
            >{{ PLANNING_RUN_STATUS[plan.status].label }}</span>
            <span class="min-w-0 basis-full text-theme-200 [overflow-wrap:anywhere] sm:basis-0 sm:flex-1 sm:truncate">{{ plan.objective || 'Untitled run' }}</span>
            <span class="shrink-0 text-ink-faint">{{ completedCount(plan) }}/{{ plan.items.length }}</span>
            <span
              class="shrink-0 text-ink-faint"
              :title="new Date(plan.createdAt).toLocaleString()"
            >{{ formatRelativeTime(plan.updatedAt) }}</span>
            <RouterLink
              :to="{ name: 'conversation', params: { conversationId: plan.conversationId } }"
              class="shrink-0 rounded p-0.5 text-ink-faint hover:text-theme-200"
              title="Open the chat of this run"
              :aria-label="`Open the chat of ${plan.objective || 'this run'}`"
              @click.stop
            >
              <Icon
                icon="lucide:message-square"
                class="h-3.5 w-3.5"
              />
            </RouterLink>
          </summary>

          <ul class="flex flex-col gap-1 px-3 pb-3">
            <li
              v-for="item in plan.items"
              :key="item.id"
              class="flex min-w-0 items-start gap-2"
            >
              <Icon
                :icon="item.status === 'in_progress' && plan.status !== 'running' ? 'lucide:circle-dot' : PLANNING_ITEM_STATUS[item.status].icon"
                class="mt-0.5 h-3.5 w-3.5 shrink-0"
                :class="PLANNING_ITEM_STATUS[item.status].cls"
              />
              <div class="min-w-0 flex-1 text-xs">
                <div
                  class="[overflow-wrap:anywhere]"
                  :class="item.status === 'completed' || item.status === 'cancelled' ? 'text-ink-secondary' : 'text-theme-200'"
                >
                  {{ item.title }}
                </div>
                <div
                  v-if="item.note"
                  class="mt-0.5 whitespace-pre-line text-[11px] text-ink-muted [overflow-wrap:anywhere]"
                >
                  {{ item.note }}
                </div>
              </div>
            </li>
            <li
              v-if="plan.result?.error || plan.result?.summary"
              class="mt-1 border-t border-theme-800 pt-2 text-[11px] whitespace-pre-line [overflow-wrap:anywhere]"
              :class="plan.result?.error ? 'text-status-warning' : 'text-ink-muted'"
            >
              {{ plan.result?.error || plan.result?.summary }}
            </li>
          </ul>
        </details>
      </li>
    </ol>
  </section>
</template>
