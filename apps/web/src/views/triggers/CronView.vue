<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../api/client'
import type { AgentDefinition, CronJob } from '../../api/types'
import { Icon } from '@iconify/vue'
import ModalDialog from '../../components/shared/ModalDialog.vue'
import ToggleSwitch from '../../components/shared/ToggleSwitch.vue'
import BaseCard from '../../components/shared/BaseCard.vue'
import DataTable, { type Column } from '../../components/shared/DataTable.vue'
import {
  buildCronExpr, cronToHuman,
  WEEKDAYS, HOUR_OPTIONS, MINUTE_OPTIONS, INTERVAL_MINUTES, FREQUENCY_OPTIONS,
  type CronFrequency
} from '../../utils/cron-helpers'

const router = useRouter()

const cronJobs = ref<CronJob[]>([])
const allAgents = ref<AgentDefinition[]>([])
const loading = ref(true)
const cronFilter = ref('')
let pollTimer: ReturnType<typeof setInterval> | undefined

// Simplified dialog state — name, agent, schedule only
const showAddCron = ref(false)
const cronName = ref('')
const cronAgentId = ref('')
const cronPrompt = ref('')
const cronSaving = ref(false)

// Schedule builder refs
const dlgFrequency = ref<CronFrequency>('daily')
const dlgEveryMinutes = ref(30)
const dlgAtMinute = ref(0)
const dlgAtHour = ref(9)
const dlgWeekday = ref(1)
const dlgMonthDay = ref(1)
const dlgCustomExpr = ref('')

const dlgParts = computed(() => ({
  frequency: dlgFrequency.value, everyMinutes: dlgEveryMinutes.value,
  atMinute: dlgAtMinute.value, atHour: dlgAtHour.value,
  weekday: dlgWeekday.value, monthDay: dlgMonthDay.value, customExpr: dlgCustomExpr.value
}))
const dlgGeneratedExpr = computed(() => buildCronExpr(dlgParts.value))
const dlgHumanReadable = computed(() => cronToHuman(dlgParts.value))

function resetDlg() {
  cronName.value = ''
  cronAgentId.value = ''
  cronPrompt.value = ''
  dlgFrequency.value = 'daily'
  dlgEveryMinutes.value = 30
  dlgAtMinute.value = 0
  dlgAtHour.value = 9
  dlgWeekday.value = 1
  dlgMonthDay.value = 1
  dlgCustomExpr.value = ''
}

async function openAddCronDialog() {
  allAgents.value = await api.agents.list()
  resetDlg()
  showAddCron.value = true
}

async function saveCronJob() {
  const expr = dlgGeneratedExpr.value
  if (!expr.trim() || !cronAgentId.value) return
  cronSaving.value = true
  try {
    const created = await api.cronJobs.create({
      name: cronName.value.trim(),
      agentId: cronAgentId.value,
      schedule: expr.trim(),
      prompt: cronPrompt.value,
      enabled: true,
    })
    showAddCron.value = false
    router.push(`/triggers/cron/${created.id}`)
  } finally {
    cronSaving.value = false
  }
}

async function toggleCronJob(jobId: string, enabled: boolean) {
  await api.cronJobs.update(jobId, { enabled })
  await loadSchedules()
}

const showDeleteConfirm = ref(false)
const pendingDeleteId = ref<string | null>(null)
const pendingDeleteName = ref('')

const runningNow = ref(new Set<string>())

async function runJobNow(jobId: string) {
  runningNow.value = new Set([...runningNow.value, jobId])
  try {
    await api.cronJobs.runNow(jobId)
    await loadSchedules()
  } finally {
    runningNow.value.delete(jobId)
    runningNow.value = new Set(runningNow.value)
  }
}

function confirmDeleteCron(job: CronJob) {
  pendingDeleteId.value = job.id
  pendingDeleteName.value = job.agentName
  showDeleteConfirm.value = true
}

async function deleteCronJobConfirmed() {
  if (!pendingDeleteId.value) return
  await api.cronJobs.delete(pendingDeleteId.value)
  showDeleteConfirm.value = false
  pendingDeleteId.value = null
  await loadSchedules()
}

const filteredCronJobs = computed(() => {
  const q = cronFilter.value.trim().toLowerCase()
  if (!q) return cronJobs.value
  return cronJobs.value.filter((job) =>
    (job.name || '').toLowerCase().includes(q)
    || job.agentName.toLowerCase().includes(q)
    || cronToHuman(job.schedule).toLowerCase().includes(q)
    || (job.prompt || '').toLowerCase().includes(q)
  )
})

const tableColumns: Column[] = [
  { key: 'job', label: 'Job', width: 'minmax(0,1.7fr)' },
  { key: 'schedule', label: 'Schedule', width: 'minmax(0,1.3fr)' },
  { key: 'status', label: 'Status', width: '140px', hideOnMobile: true, hideOnTablet: true },
  { key: 'actions', label: 'Actions', width: '170px', hideOnMobile: true },
  { key: 'enable', label: 'Enable', width: '72px', hideOnMobile: true },
]

function openCronJob(job: CronJob) {
  router.push(`/triggers/cron/${job.id}`)
}

// ─── Ticking countdown ───────────────────────────────────

const now = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | undefined

function formatCountdown(nextRunAt: number | null): string {
  if (!nextRunAt) return ''
  const diff = nextRunAt - now.value
  if (diff <= 0) return 'any moment'
  const totalSec = Math.floor(diff / 1000)
  const days = Math.floor(totalSec / 86400)
  const hours = Math.floor((totalSec % 86400) / 3600)
  const minutes = Math.floor((totalSec % 3600) / 60)
  const seconds = totalSec % 60
  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function sortCronJobs(items: CronJob[]): CronJob[] {
  return [...items].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    return (a.name || a.agentName).localeCompare(b.name || b.agentName)
  })
}

async function loadSchedules() {
  try {
    cronJobs.value = sortCronJobs(await api.cronJobs.list())
  } catch {
    // silently ignore
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadSchedules()
  pollTimer = setInterval(loadSchedules, 10_000)
  tickTimer = setInterval(() => { now.value = Date.now() }, 1000)
})

onUnmounted(() => {
  clearInterval(pollTimer)
  clearInterval(tickTimer)
})
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-6xl mx-auto py-8 px-6">
      <div class="mb-4">
        <div>
          <h1 class="text-2xl font-bold text-zinc-100">
            Scheduled Jobs
          </h1>
          <p class="text-sm text-zinc-500 mt-1">
            Cron jobs running on recurring schedules
          </p>
        </div>
      </div>

      <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-6">
        <button
          class="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-sm font-medium text-white transition-colors"
          @click="openAddCronDialog"
        >
          <Icon
            icon="lucide:plus"
            class="w-4 h-4"
          />
          Add Cron Job
        </button>

        <div class="relative w-full md:w-80 md:ml-auto">
          <Icon
            icon="lucide:search"
            class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500"
          />
          <input
            v-model="cronFilter"
            type="text"
            placeholder="Filter scheduled jobs..."
            class="w-full h-10 pl-10 pr-3 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
        </div>
      </div>

      <!-- Loading -->
      <BaseCard
        v-if="loading"
        class="p-12 text-center"
      >
        <Icon
          icon="lucide:loader-2"
          class="w-8 h-8 text-zinc-500 animate-spin mx-auto mb-3"
        />
        <p class="text-sm text-zinc-500">
          Loading schedules…
        </p>
      </BaseCard>
      <template v-else>
        <!-- Empty -->
        <BaseCard
          v-if="cronJobs.length === 0"
          class="p-12 text-center"
        >
          <div class="w-16 h-16 rounded-2xl bg-zinc-800 flex items-center justify-center mx-auto mb-4">
            <Icon
              icon="lucide:clock"
              class="w-8 h-8 text-zinc-600"
            />
          </div>
          <h3 class="text-lg font-medium text-zinc-200 mb-2">
            No cron jobs
          </h3>
          <p class="text-sm text-zinc-500 max-w-md mx-auto mb-4">
            Create a cron job to run an agent on a recurring schedule.
          </p>
          <button
            class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-sm font-medium text-white transition-colors"
            @click="openAddCronDialog"
          >
            <Icon
              icon="lucide:plus"
              class="w-4 h-4"
            />
            Add Cron Job
          </button>
        </BaseCard>

        <DataTable
          v-else
          :items="filteredCronJobs"
          :columns="tableColumns"
          :empty-message="cronFilter.trim() ? 'No jobs match the current filter' : 'No cron jobs'"
          @row-click="openCronJob"
        >
          <template #col-job="{ item: job }">
            <div class="flex items-start gap-3 min-w-0">
              <div class="w-9 h-9 rounded-full bg-zinc-700 flex items-center justify-center shrink-0 overflow-hidden mt-0.5">
                <img
                  v-if="job.agentIconUrl"
                  :src="job.agentIconUrl"
                  :alt="job.agentName"
                  class="w-full h-full object-cover"
                >
                <Icon
                  v-else
                  icon="lucide:bot"
                  class="w-4 h-4 text-zinc-400"
                />
              </div>
              <div class="min-w-0">
                <div class="font-medium text-zinc-100 truncate">
                  {{ job.name || 'Unnamed job' }}
                </div>
                <div class="mt-0.5 text-xs text-zinc-400 flex items-center gap-1.5">
                  <Icon
                    icon="lucide:bot"
                    class="w-3 h-3"
                  />
                  <span class="truncate">{{ job.agentName }}</span>
                </div>
                <div
                  v-if="job.prompt"
                  class="mt-0.5 text-xs text-zinc-500 flex items-center gap-1.5"
                >
                  <Icon
                    icon="lucide:message-square"
                    class="w-3 h-3"
                  />
                  <span class="truncate">{{ job.prompt }}</span>
                </div>
              </div>
            </div>
          </template>

          <template #col-schedule="{ item: job }">
            <div class="text-xs text-zinc-300">
              <div class="flex items-center gap-1.5">
                <Icon
                  icon="lucide:clock"
                  class="w-3 h-3"
                  :class="job.enabled ? 'text-sky-400' : 'text-zinc-500'"
                />
                <span>{{ cronToHuman(job.schedule) }}</span>
              </div>
              <div
                v-if="job.enabled && job.nextRunAt && !job.isRunning"
                class="mt-1 text-emerald-400/80 tabular-nums"
              >
                <Icon
                  icon="lucide:timer"
                  class="w-3 h-3 inline -mt-px mr-0.5"
                />{{ formatCountdown(job.nextRunAt) }}
              </div>
            </div>
          </template>

          <template #col-status="{ item: job }">
            <div class="flex flex-wrap items-center gap-1.5">
              <span
                v-if="job.isRunning"
                class="px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-emerald-500/20 text-emerald-400"
              >EXECUTING</span>
              <span
                v-else-if="job.enabled"
                class="px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-sky-500/20 text-sky-400"
              >SCHEDULED</span>
              <span
                v-else
                class="px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-zinc-500/20 text-zinc-500"
              >PAUSED</span>
              <span
                v-if="job.oneOff"
                class="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-amber-500/10 text-amber-400"
              >One-off</span>
            </div>
          </template>

          <template #col-actions="{ item: job }">
            <div class="flex items-center gap-1">
              <button
                class="p-1.5 rounded-lg text-zinc-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-40"
                title="Execute now"
                :disabled="runningNow.has(job.id) || job.isRunning"
                @click.stop="runJobNow(job.id)"
              >
                <Icon
                  :icon="runningNow.has(job.id) ? 'lucide:loader-2' : 'lucide:play'"
                  class="w-4 h-4"
                  :class="{ 'animate-spin': runningNow.has(job.id) }"
                />
              </button>
              <button
                class="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
                title="Edit"
                @click.stop="openCronJob(job)"
              >
                <Icon
                  icon="lucide:pencil"
                  class="w-4 h-4"
                />
              </button>
              <button
                class="p-1.5 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                title="Delete"
                @click.stop="confirmDeleteCron(job)"
              >
                <Icon
                  icon="lucide:trash-2"
                  class="w-4 h-4"
                />
              </button>
            </div>
          </template>

          <template #col-enable="{ item: job }">
            <div class="flex items-center justify-center">
              <ToggleSwitch
                :model-value="job.enabled"
                size="sm"
                color="emerald"
                :title="job.enabled ? 'Pause cron job' : 'Enable cron job'"
                @update:model-value="toggleCronJob(job.id, !job.enabled)"
                @click.stop
              />
            </div>
          </template>
        </DataTable>
      </template>
    </div>

    <!-- Add Cron Job Dialog (simplified) -->
    <Teleport to="body">
      <div
        v-if="showAddCron"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        @click.self="showAddCron = false"
      >
        <div class="w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl p-6 max-h-[90vh] overflow-y-auto">
          <h2 class="text-lg font-semibold text-zinc-100 mb-4">
            New Cron Job
          </h2>

          <div class="space-y-4">
            <!-- Job name -->
            <div>
              <label class="block text-sm text-zinc-400 mb-1">Name</label>
              <input
                v-model="cronName"
                type="text"
                placeholder="e.g. Daily health check"
                class="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
            </div>

            <!-- Agent picker -->
            <div>
              <label class="block text-sm text-zinc-400 mb-1">Agent</label>
              <select
                v-model="cronAgentId"
                class="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option
                  value=""
                  disabled
                >
                  Select an agent…
                </option>
                <option
                  v-for="a in allAgents"
                  :key="a.id"
                  :value="a.id"
                >
                  {{ a.name }}
                </option>
              </select>
            </div>

            <!-- Schedule builder -->
            <div>
              <label class="block text-sm text-zinc-400 mb-2">Schedule</label>
              <div class="grid grid-cols-3 gap-1.5 mb-3">
                <button
                  v-for="opt in FREQUENCY_OPTIONS"
                  :key="opt.value"
                  type="button"
                  class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs transition-colors"
                  :class="dlgFrequency === opt.value
                    ? 'border-blue-500 bg-blue-500/10 text-blue-400'
                    : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'"
                  @click="dlgFrequency = opt.value"
                >
                  <Icon
                    :icon="opt.icon"
                    class="w-3.5 h-3.5"
                  />
                  {{ opt.label }}
                </button>
              </div>

              <!-- Every X minutes -->
              <div
                v-if="dlgFrequency === 'minutes'"
                class="flex items-center gap-2 mb-3"
              >
                <span class="text-sm text-zinc-400">Every</span>
                <select
                  v-model.number="dlgEveryMinutes"
                  class="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option
                    v-for="m in INTERVAL_MINUTES"
                    :key="m"
                    :value="m"
                  >
                    {{ m }}
                  </option>
                </select>
                <span class="text-sm text-zinc-400">minutes</span>
              </div>

              <!-- Hourly -->
              <div
                v-else-if="dlgFrequency === 'hourly'"
                class="flex items-center gap-2 mb-3"
              >
                <span class="text-sm text-zinc-400">Every hour at minute</span>
                <select
                  v-model.number="dlgAtMinute"
                  class="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option
                    v-for="m in MINUTE_OPTIONS"
                    :key="m"
                    :value="m"
                  >
                    :{{ String(m).padStart(2, '0') }}
                  </option>
                </select>
              </div>

              <!-- Daily -->
              <div
                v-else-if="dlgFrequency === 'daily'"
                class="flex items-center gap-2 mb-3"
              >
                <span class="text-sm text-zinc-400">Every day at</span>
                <select
                  v-model.number="dlgAtHour"
                  class="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option
                    v-for="h in HOUR_OPTIONS"
                    :key="h"
                    :value="h"
                  >
                    {{ String(h).padStart(2, '0') }}
                  </option>
                </select>
                <span class="text-sm text-zinc-400">:</span>
                <select
                  v-model.number="dlgAtMinute"
                  class="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option
                    v-for="m in MINUTE_OPTIONS"
                    :key="m"
                    :value="m"
                  >
                    {{ String(m).padStart(2, '0') }}
                  </option>
                </select>
              </div>

              <!-- Weekly -->
              <div
                v-else-if="dlgFrequency === 'weekly'"
                class="flex items-center gap-2 flex-wrap mb-3"
              >
                <span class="text-sm text-zinc-400">Every</span>
                <select
                  v-model.number="dlgWeekday"
                  class="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option
                    v-for="(label, i) in WEEKDAYS"
                    :key="i"
                    :value="i"
                  >
                    {{ label }}
                  </option>
                </select>
                <span class="text-sm text-zinc-400">at</span>
                <select
                  v-model.number="dlgAtHour"
                  class="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option
                    v-for="h in HOUR_OPTIONS"
                    :key="h"
                    :value="h"
                  >
                    {{ String(h).padStart(2, '0') }}
                  </option>
                </select>
                <span class="text-sm text-zinc-400">:</span>
                <select
                  v-model.number="dlgAtMinute"
                  class="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option
                    v-for="m in MINUTE_OPTIONS"
                    :key="m"
                    :value="m"
                  >
                    {{ String(m).padStart(2, '0') }}
                  </option>
                </select>
              </div>

              <!-- Monthly -->
              <div
                v-else-if="dlgFrequency === 'monthly'"
                class="flex items-center gap-2 flex-wrap mb-3"
              >
                <span class="text-sm text-zinc-400">On day</span>
                <select
                  v-model.number="dlgMonthDay"
                  class="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option
                    v-for="d in 28"
                    :key="d"
                    :value="d"
                  >
                    {{ d }}
                  </option>
                </select>
                <span class="text-sm text-zinc-400">at</span>
                <select
                  v-model.number="dlgAtHour"
                  class="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option
                    v-for="h in HOUR_OPTIONS"
                    :key="h"
                    :value="h"
                  >
                    {{ String(h).padStart(2, '0') }}
                  </option>
                </select>
                <span class="text-sm text-zinc-400">:</span>
                <select
                  v-model.number="dlgAtMinute"
                  class="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option
                    v-for="m in MINUTE_OPTIONS"
                    :key="m"
                    :value="m"
                  >
                    {{ String(m).padStart(2, '0') }}
                  </option>
                </select>
              </div>

              <!-- Custom -->
              <div
                v-else-if="dlgFrequency === 'custom'"
                class="mb-3"
              >
                <input
                  v-model="dlgCustomExpr"
                  type="text"
                  placeholder="*/30 * * * *"
                  class="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                >
                <p class="text-[11px] text-zinc-600 mt-1">
                  Standard cron: minute hour day-of-month month day-of-week
                </p>
              </div>

              <!-- Schedule summary -->
              <div class="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800/50 border border-zinc-800">
                <Icon
                  icon="lucide:calendar-clock"
                  class="w-3.5 h-3.5 text-sky-400 shrink-0"
                />
                <span class="text-xs text-zinc-300">{{ dlgHumanReadable }}</span>
                <code class="ml-auto text-[11px] text-zinc-600 font-mono">{{ dlgGeneratedExpr }}</code>
              </div>
            </div>

            <!-- Prompt -->
            <div>
              <label class="block text-sm text-zinc-400 mb-1">Prompt (optional)</label>
              <textarea
                v-model="cronPrompt"
                rows="3"
                placeholder="Describe what the agent should do on each cron trigger…"
                class="w-full bg-zinc-800 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
              />
            </div>
          </div>

          <!-- Actions -->
          <div class="flex justify-end gap-3 mt-6">
            <button
              class="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
              @click="showAddCron = false"
            >
              Cancel
            </button>
            <button
              :disabled="!cronAgentId || !dlgGeneratedExpr.trim() || cronSaving"
              class="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors"
              @click="saveCronJob"
            >
              {{ cronSaving ? 'Creating…' : 'Create' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Delete Confirmation -->
    <ModalDialog
      :show="showDeleteConfirm"
      title="Delete Cron Job"
      icon="lucide:trash-2"
      icon-color="red"
      @close="showDeleteConfirm = false"
    >
      <p class="text-zinc-400 leading-relaxed">
        Are you sure you want to delete the cron job for
        <strong class="text-zinc-200">{{ pendingDeleteName }}</strong>?
        This will clear the schedule and disable the job.
      </p>
      <template #actions>
        <button
          class="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-sm font-medium text-white transition-colors"
          @click="deleteCronJobConfirmed()"
        >
          Delete
        </button>
        <button
          class="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          @click="showDeleteConfirm = false"
        >
          Cancel
        </button>
      </template>
    </ModalDialog>
  </div>
</template>
