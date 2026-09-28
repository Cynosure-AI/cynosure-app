<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onClickOutside } from '@vueuse/core'
import { Icon } from '@iconify/vue'
import { useRouter } from 'vue-router'
import { api } from '../../api/client'
import type { CronJob } from '../../api/types'
import { useChatStore } from '../../stores/chat.store'
import { cronToHuman } from '../../utils/cron-helpers'

const chatStore = useChatStore()
const router = useRouter()
const root = ref<HTMLElement | null>(null)
const open = ref(false)
const jobs = ref<CronJob[]>([])
let pollTimer: ReturnType<typeof setInterval> | undefined
let requestId = 0

const agentJobs = computed(() => jobs.value
  .filter(job => job.agentId === (chatStore.activeAgentId ?? ''))
  .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || a.name.localeCompare(b.name)))

async function loadJobs(): Promise<void> {
  const currentRequest = ++requestId
  try {
    const result = await api.cronJobs.list()
    if (currentRequest === requestId) jobs.value = result
  } catch {
    // Preserve the last known list through a transient connection failure.
  }
}

function toggle(): void {
  open.value = !open.value
  if (open.value) void loadJobs()
}

function executionTime(job: CronJob): string {
  if (!job.enabled) return 'Disabled'
  if (!job.nextRunAt) return cronToHuman(job.schedule)
  return `Next ${new Date(job.nextRunAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`
}

function openJob(job: CronJob): void {
  open.value = false
  void router.push({ name: 'cron-detail', params: { id: job.id } })
}

onClickOutside(root, () => { open.value = false })
watch(() => chatStore.activeAgentId, () => { open.value = false })
watch(agentJobs, list => { if (!list.length) open.value = false })
onMounted(() => {
  void loadJobs()
  pollTimer = setInterval(() => void loadJobs(), 30_000)
})
onBeforeUnmount(() => {
  requestId++
  clearInterval(pollTimer)
})
</script>

<template>
  <div
    v-if="agentJobs.length"
    ref="root"
    class="relative shrink-0"
  >
    <button
      type="button"
      class="rounded-lg p-1.5 text-theme-300 transition-colors hover:bg-theme-800 hover:text-theme-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
      title="Schedules"
      aria-label="Schedules"
      :aria-expanded="open"
      @click="toggle"
    >
      <Icon
        icon="lucide:clock"
        class="h-4 w-4"
      />
    </button>
    <div
      v-if="open"
      class="absolute right-0 top-full z-50 mt-2 flex max-h-96 w-[min(20rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-theme-700 bg-theme-900 shadow-2xl shadow-black/40"
      role="dialog"
      aria-label="Agent schedules"
      @keydown.esc.stop="open = false"
    >
      <div class="border-b border-theme-700 px-3 py-2.5 text-xs font-semibold text-theme-100">
        Schedules
      </div>
      <div class="overflow-y-auto p-1.5">
        <div
          v-for="job in agentJobs"
          :key="job.id"
          class="rounded-lg"
        >
          <button
            type="button"
            class="w-full rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-theme-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500"
            :class="job.enabled ? 'text-theme-200' : 'text-ink-muted'"
            :aria-label="`Open schedule ${job.name || job.prompt || 'Untitled schedule'}`"
            @click="openJob(job)"
          >
            <div class="truncate text-xs font-medium">
              {{ job.name || job.prompt || 'Untitled schedule' }}
            </div>
            <div
              v-if="job.name && job.prompt"
              class="mt-0.5 line-clamp-2 text-[11px] opacity-75"
            >
              {{ job.prompt }}
            </div>
            <div class="mt-1 flex items-center gap-1 text-[10px] opacity-75">
              <Icon
                icon="lucide:clock-3"
                class="h-3 w-3 shrink-0"
              />
              <span>{{ cronToHuman(job.schedule) }}</span>
              <span v-if="job.enabled && job.nextRunAt">· {{ executionTime(job) }}</span>
              <span v-else-if="!job.enabled">· Disabled</span>
            </div>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
