<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../api/client'
import type { AgentDefinition, CronJob } from '../../api/types'
import type { ProjectDto } from '@shared/types'
import { Icon } from '@iconify/vue'
import ModalDialog from '../../components/shared/ModalDialog.vue'
import ToggleSwitch from '../../components/shared/ToggleSwitch.vue'
import BaseCard from '../../components/shared/BaseCard.vue'
import AgentSelect from '../../components/shared/AgentSelect.vue'
import CustomSelect from '../../components/shared/CustomSelect.vue'
import ProjectIcon from '../../components/project/ProjectIcon.vue'
import {
  buildCronExpr, cronToHuman,
  WEEKDAYS, HOUR_OPTIONS, MINUTE_OPTIONS, INTERVAL_MINUTES, FREQUENCY_OPTIONS,
  type CronFrequency
} from '../../utils/cron-helpers'
import { groupByNextRun, type ScheduleGroup } from '../../utils/schedule-groups'
import { useCynoStore } from '../../stores/cyno.store'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import AgentAvatar from '../../components/shared/AgentAvatar.vue'

const cyno = useCynoStore()
const agentDefs = useAgentDefinitionsStore()
// Avatar settings live on the definitions; load them if this page opened first.
if (!agentDefs.loaded) void agentDefs.load()

const router = useRouter()

const cronJobs = ref<CronJob[]>([])
const projects = ref<ProjectDto[]>([])
const projectsById = computed(() => new Map(projects.value.map(project => [project.id, project])))
function jobProject(job: CronJob): ProjectDto | undefined {
  return job.projectId ? projectsById.value.get(job.projectId) : undefined
}
function projectName(job: CronJob): string {
  return jobProject(job)?.name || ''
}
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
/** Why creating the job in the dialog failed. */
const createError = ref('')
/** Why the last list action (toggle, run, duplicate, delete) failed. */
const actionError = ref('')
const deletingJob = ref(false)

function errorText(action: string, error: unknown): string {
  return `${action}: ${error instanceof Error ? error.message : 'unknown error'}`
}

// Schedule builder refs
const dlgFrequency = ref<CronFrequency>('daily')
const dlgEveryMinutes = ref(30)
const dlgAtMinute = ref(0)
const dlgAtHour = ref(9)
const dlgWeekday = ref(1)
const dlgMonthDay = ref(1)
const dlgCustomExpr = ref('')
const dlgFrequencyValue = computed({
  get: () => dlgFrequency.value,
  set: (value: string) => { dlgFrequency.value = value as CronFrequency },
})
const frequencyGroups = [{
  options: FREQUENCY_OPTIONS.map(option => ({
    value: option.value,
    label: option.label,
    iconName: option.icon,
  })),
}]

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
  actionError.value = ''
  try {
    allAgents.value = await api.agents.list()
  } catch (error) {
    actionError.value = errorText('Agents could not be loaded', error)
    return
  }
  resetDlg()
  createError.value = ''
  showAddCron.value = true
}

async function saveCronJob() {
  const expr = dlgGeneratedExpr.value
  if (!expr.trim()) return
  cronSaving.value = true
  createError.value = ''
  try {
    const created = await api.cronJobs.create({
      name: cronName.value.trim(),
      agentId: cronAgentId.value,
      schedule: expr.trim(),
      prompt: cronPrompt.value,
      enabled: true,
    })
    showAddCron.value = false
    router.push(`/cron/${encodeURIComponent(created.id)}`)
  } catch (error) {
    createError.value = errorText('The job was not created', error)
  } finally {
    cronSaving.value = false
  }
}

async function toggleCronJob(jobId: string, enabled: boolean) {
  actionError.value = ''
  try {
    await api.cronJobs.update(jobId, { enabled })
  } catch (error) {
    actionError.value = errorText(enabled ? 'The job could not be enabled' : 'The job could not be paused', error)
  }
  // Reload either way so the switch reflects the saved state.
  await loadSchedules()
}

const showDeleteConfirm = ref(false)
const pendingDeleteId = ref<string | null>(null)
const pendingDeleteName = ref('')

const runningNow = ref(new Set<string>())
const duplicatingNow = ref(new Set<string>())

async function runJobNow(jobId: string) {
  runningNow.value = new Set([...runningNow.value, jobId])
  actionError.value = ''
  try {
    await api.cronJobs.runNow(jobId)
    await loadSchedules()
  } catch (error) {
    actionError.value = errorText('The job could not be started', error)
  } finally {
    runningNow.value.delete(jobId)
    runningNow.value = new Set(runningNow.value)
  }
}

async function duplicateCronJob(job: CronJob) {
  duplicatingNow.value = new Set([...duplicatingNow.value, job.id])
  actionError.value = ''
  try {
    const created = await api.cronJobs.create({
      name: `${job.name || job.agentName} Copy`,
      agentId: job.agentId,
      schedule: job.schedule,
      prompt: job.prompt || '',
      enabled: false,
      oneOff: job.oneOff,
      outputChannelId: job.outputChannelId,
      notificationMode: job.notificationMode,
      notificationCondition: job.notificationCondition,
      executionConfig: job.executionConfig || undefined,
    })
    await loadSchedules()
    router.push(`/cron/${encodeURIComponent(created.id)}`)
  } catch (error) {
    actionError.value = errorText('The job could not be duplicated', error)
  } finally {
    duplicatingNow.value.delete(job.id)
    duplicatingNow.value = new Set(duplicatingNow.value)
  }
}

function confirmDeleteCron(job: CronJob) {
  pendingDeleteId.value = job.id
  pendingDeleteName.value = job.name.trim() || `${job.agentName} job`
  actionError.value = ''
  showDeleteConfirm.value = true
}

async function deleteCronJobConfirmed() {
  if (!pendingDeleteId.value || deletingJob.value) return
  deletingJob.value = true
  try {
    await api.cronJobs.delete(pendingDeleteId.value)
    showDeleteConfirm.value = false
    pendingDeleteId.value = null
    await loadSchedules()
  } catch (error) {
    showDeleteConfirm.value = false
    actionError.value = errorText('The job could not be deleted', error)
  } finally {
    deletingJob.value = false
  }
}

function matchesCronFilter(job: CronJob, q: string): boolean {
  return (
    (job.name || '').toLowerCase().includes(q)
    || job.agentName.toLowerCase().includes(q)
    || cronToHuman(job.schedule).toLowerCase().includes(q)
    || (job.prompt || '').toLowerCase().includes(q)
    || projectName(job).toLowerCase().includes(q)
  )
}

function openCronJob(job: CronJob) {
  router.push(`/cron/${encodeURIComponent(job.id)}`)
}

function openAgentDetails(agentId: string) {
  router.push(agentId ? `/agents/${agentId}` : { name: 'cyno' })
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
  if (days > 0) return `in ${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `in ${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `in ${minutes}m ${seconds}s`
  return `in ${seconds}s`
}

// ─── Grouping by next run ────────────────────────────────

const jobGroups = computed(() => {
  const q = cronFilter.value.trim().toLowerCase()
  const jobs = q ? cronJobs.value.filter(job => matchesCronFilter(job, q)) : cronJobs.value
  return groupByNextRun(jobs, now.value)
})

const weekdayFormat = new Intl.DateTimeFormat([], { weekday: 'short' })
const dayFormat = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' })
const timeFormat = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' })
const rangeFormat = new Intl.DateTimeFormat([], { weekday: 'short', month: 'short', day: 'numeric' })

function groupRange(group: ScheduleGroup<CronJob>): string {
  if (group.start == null) return ''
  const first = rangeFormat.format(group.start)
  if (group.end == null) return `From ${first}`
  const last = rangeFormat.format(group.end - 1)
  return first === last ? first : `${first} – ${last}`
}

async function loadSchedules() {
  try {
    const [jobs, projectList] = await Promise.all([
      api.cronJobs.list(),
      api.projects.list(true).catch(() => projects.value),
    ])
    cronJobs.value = jobs
    projects.value = projectList
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
    <header class="page-header z-10 border-b border-theme-800/60 bg-theme-950/95 py-4 backdrop-blur-sm sm:sticky sm:top-0 sm:py-5">
      <div class="mx-auto flex max-w-7xl flex-col gap-4 px-4 sm:flex-row sm:items-start sm:justify-between sm:px-6 lg:px-8">
        <div class="min-w-0">
          <h1 class="text-2xl font-bold text-theme-100">
            Scheduled Jobs
          </h1>
          <p class="mt-1 text-sm leading-relaxed text-ink-muted">
            Run agents automatically on a recurring schedule
          </p>
        </div>
        <div class="flex w-full min-w-0 items-center gap-2 sm:w-auto">
          <label class="relative min-w-0 flex-1 sm:w-80 sm:flex-none">
            <span class="sr-only">Search scheduled jobs</span>
            <Icon
              icon="lucide:search"
              class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
            />
            <input
              v-model="cronFilter"
              type="search"
              placeholder="Filter scheduled jobs..."
              class="h-10 w-full rounded-xl border border-theme-700 bg-theme-950/70 pl-9 pr-3 text-sm text-theme-200 outline-none transition placeholder:text-ink-faint focus:border-accent-500/60 focus:ring-2 focus:ring-accent-500/10"
            >
          </label>
          <button
            class="flex h-10 shrink-0 items-center gap-2 rounded-lg accent-action bg-accent-600 px-4 text-sm font-medium text-accent-on transition-colors hover:bg-accent-500"
            @click="openAddCronDialog"
          >
            <Icon
              icon="lucide:plus"
              class="h-4 w-4"
            />
            New Scheduled Job
          </button>
        </div>
      </div>
    </header>

    <div class="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <p
        v-if="actionError"
        class="mb-4 flex items-start justify-between gap-3 rounded-lg border border-red-400/25 bg-red-400/10 px-3 py-2 text-sm text-status-danger"
        role="alert"
      >
        <span>{{ actionError }}</span>
        <button
          type="button"
          class="shrink-0 rounded p-0.5 text-status-danger/80 hover:text-status-danger"
          aria-label="Dismiss error"
          @click="actionError = ''"
        >
          <Icon
            icon="lucide:x"
            class="h-4 w-4"
          />
        </button>
      </p>
      <!-- Loading -->
      <BaseCard
        v-if="loading"
        class="p-12 text-center"
      >
        <Icon
          icon="lucide:loader-2"
          class="w-8 h-8 text-ink-muted animate-spin mx-auto mb-3"
        />
        <p class="text-sm text-ink-muted">
          Loading schedules…
        </p>
      </BaseCard>
      <template v-else>
        <!-- Empty -->
        <BaseCard
          v-if="cronJobs.length === 0"
          class="p-12 text-center"
        >
          <div class="w-16 h-16 rounded-2xl bg-theme-800 flex items-center justify-center mx-auto mb-4">
            <Icon
              icon="lucide:clock"
              class="w-8 h-8 text-ink-faint"
            />
          </div>
          <h3 class="text-lg font-medium text-theme-200 mb-2">
            No scheduled jobs
          </h3>
          <p class="text-sm text-ink-muted max-w-md mx-auto mb-4">
            Create a scheduled job to run an agent automatically.
          </p>
          <button
            class="inline-flex items-center gap-2 px-4 py-2 rounded-lg accent-action bg-accent-600 hover:bg-accent-500 text-sm font-medium text-accent-on transition-colors"
            @click="openAddCronDialog"
          >
            <Icon
              icon="lucide:plus"
              class="w-4 h-4"
            />
            New Scheduled Job
          </button>
        </BaseCard>

        <BaseCard
          v-else-if="jobGroups.length === 0"
          class="p-8 text-center text-sm text-ink-muted"
        >
          No jobs match the current filter
        </BaseCard>

        <div
          v-else
          class="space-y-8"
        >
          <section
            v-for="group in jobGroups"
            :key="group.key"
            :aria-labelledby="`schedule-group-${group.key}`"
          >
            <div class="mb-3 flex items-center gap-3">
              <h2
                :id="`schedule-group-${group.key}`"
                class="shrink-0 text-sm font-semibold uppercase tracking-[0.14em] text-theme-100"
              >
                {{ group.label }}
              </h2>
              <span
                v-if="groupRange(group)"
                class="shrink-0 rounded-md border border-theme-700 bg-theme-800/60 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-ink-muted"
              >{{ groupRange(group) }}</span>
              <span
                class="h-px flex-1 bg-theme-800"
                aria-hidden="true"
              />
              <span class="shrink-0 text-xs tabular-nums text-ink-faint">{{ group.items.length }}</span>
            </div>

            <ul class="space-y-2">
              <li
                v-for="job in group.items"
                :key="job.id"
                class="grid cursor-pointer grid-cols-[4.5rem_2.5rem_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 rounded-xl border border-l-2 border-theme-700/70 bg-theme-900/60 px-4 py-3 transition-colors hover:border-theme-600 hover:bg-theme-800/60 lg:grid-cols-[5rem_2.75rem_minmax(0,1fr)_13rem_9rem_auto_auto]"
                :class="job.isRunning ? 'border-l-emerald-500/80' : job.enabled ? 'border-l-accent-500/70' : 'border-l-theme-600'"
                @click="openCronJob(job)"
              >
                <!-- When -->
                <div class="flex h-full flex-col justify-center border-r border-theme-700/70 pr-3 leading-tight">
                  <template v-if="job.isRunning">
                    <Icon
                      icon="lucide:activity"
                      class="mb-1 h-4 w-4 text-status-success"
                    />
                    <span class="text-xs font-semibold uppercase tracking-wider text-status-success">Now</span>
                  </template>
                  <template v-else-if="job.enabled && job.nextRunAt">
                    <span class="text-[11px] font-semibold uppercase tracking-wider text-accent-fg">{{ weekdayFormat.format(job.nextRunAt) }}</span>
                    <span class="text-sm font-semibold uppercase tabular-nums text-theme-100">{{ dayFormat.format(job.nextRunAt) }}</span>
                    <span class="text-xs tabular-nums text-ink-muted">{{ timeFormat.format(job.nextRunAt) }}</span>
                  </template>
                  <template v-else>
                    <Icon
                      :icon="job.enabled ? 'lucide:calendar-off' : 'lucide:pause'"
                      class="mb-1 h-4 w-4 text-ink-faint"
                    />
                    <span class="text-xs font-semibold uppercase tracking-wider text-ink-faint">{{ job.enabled ? 'None' : 'Paused' }}</span>
                  </template>
                </div>

                <!-- Agent -->
                <div class="relative h-10 w-10 shrink-0 lg:h-11 lg:w-11">
                  <button
                    type="button"
                    class="flex h-full w-full items-center justify-center overflow-hidden rounded-full transition-shadow hover:ring-2 hover:ring-accent-500/60"
                    :class="[job.agentIconUrl ? 'bg-theme-700' : 'bg-theme-800/60', { 'opacity-60 grayscale': !job.enabled }]"
                    :title="`Open ${job.agentName} agent details`"
                    :aria-label="`Open ${job.agentName} agent details`"
                    @click.stop="openAgentDetails(job.agentId)"
                  >
                    <AgentAvatar
                      :name="job.agentName || cyno.name"
                      :icon-url="job.agentIconUrl"
                      :avatar="job.agentId ? agentDefs.get(job.agentId)?.avatar : cyno.avatar"
                      :pending="job.agentId ? !agentDefs.loaded : !cyno.profile"
                      :mood="job.conversationId ? 'sleepy' : 'idle'"
                      animate="hover"
                    />
                  </button>
                  <RouterLink
                    v-if="jobProject(job)"
                    :to="`/projects/${encodeURIComponent(job.projectId!)}`"
                    class="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border bg-theme-900 ring-2 ring-theme-900 transition-shadow hover:ring-accent-500/60 focus-visible:outline-none focus-visible:ring-accent-500/60"
                    :style="{ borderColor: jobProject(job)!.color || 'var(--color-accent-500)' }"
                    :title="`Project: ${projectName(job)}`"
                    :aria-label="`Open project ${projectName(job)}`"
                    @click.stop
                  >
                    <ProjectIcon
                      :project="jobProject(job)!"
                      class="h-3 w-3"
                    />
                  </RouterLink>
                </div>

                <!-- Name, instructions -->
                <div class="min-w-0">
                  <RouterLink
                    :to="`/cron/${encodeURIComponent(job.id)}`"
                    class="block truncate font-medium hover:text-accent-fg"
                    :class="job.enabled ? 'text-theme-100' : 'text-theme-300'"
                    @click.stop
                  >
                    {{ job.name || 'Unnamed job' }}
                  </RouterLink>
                  <p
                    v-if="job.prompt"
                    class="mt-0.5 truncate text-xs text-ink-muted"
                  >
                    {{ job.prompt }}
                  </p>
                </div>

                <!-- Below lg this wraps onto a second line; from lg on its children are grid cells. -->
                <div class="col-span-full flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-theme-800/70 pt-3 lg:contents">
                  <!-- Schedule -->
                  <div class="min-w-0 text-xs text-theme-300">
                    <div class="flex items-center gap-1.5">
                      <Icon
                        icon="lucide:clock"
                        class="h-3.5 w-3.5 shrink-0"
                        :class="job.enabled ? 'text-status-info' : 'text-ink-muted'"
                      />
                      <span class="truncate">{{ cronToHuman(job.schedule) }}</span>
                    </div>
                    <div
                      v-if="job.enabled && job.nextRunAt && !job.isRunning"
                      class="mt-1 flex items-center gap-1.5 tabular-nums text-status-success/80"
                    >
                      <Icon
                        icon="lucide:timer"
                        class="h-3.5 w-3.5 shrink-0"
                      />
                      {{ formatCountdown(job.nextRunAt) }}
                    </div>
                  </div>

                  <!-- Status -->
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span
                      v-if="job.isRunning"
                      class="rounded-md px-2 py-0.5 text-[10px] font-semibold tracking-wider bg-emerald-500/15 text-status-success ring-1 ring-inset ring-emerald-500/30"
                    >EXECUTING</span>
                    <span
                      v-else-if="job.enabled"
                      class="rounded-md px-2 py-0.5 text-[10px] font-semibold tracking-wider bg-sky-500/15 text-status-info ring-1 ring-inset ring-sky-500/30"
                    >SCHEDULED</span>
                    <span
                      v-else
                      class="rounded-md px-2 py-0.5 text-[10px] font-semibold tracking-wider bg-theme-500/15 text-ink-muted ring-1 ring-inset ring-theme-500/30"
                    >PAUSED</span>
                    <button
                      v-if="job.conversationId"
                      type="button"
                      class="rounded-md px-2 py-0.5 text-[10px] font-medium bg-sky-500/10 text-status-info ring-1 ring-inset ring-sky-500/20 transition-colors hover:bg-sky-500/20"
                      title="Resumes its conversation. Click to open it."
                      @click.stop="router.push(`/chat/${encodeURIComponent(job.conversationId)}`)"
                    >
                      Wait
                    </button>
                    <span
                      v-else-if="job.oneOff"
                      class="rounded-md px-2 py-0.5 text-[10px] font-medium bg-amber-500/10 text-status-warning ring-1 ring-inset ring-amber-500/25"
                    >One-off</span>
                  </div>

                  <!-- Actions -->
                  <div class="flex items-center gap-1">
                    <button
                      type="button"
                      class="rounded-lg p-1.5 text-ink-secondary transition-colors hover:bg-emerald-500/10 hover:text-status-success disabled:opacity-40"
                      title="Execute now"
                      aria-label="Execute now"
                      :disabled="runningNow.has(job.id) || job.isRunning"
                      @click.stop="runJobNow(job.id)"
                    >
                      <Icon
                        :icon="runningNow.has(job.id) ? 'lucide:loader-2' : 'lucide:play'"
                        class="h-4 w-4"
                        :class="{ 'animate-spin': runningNow.has(job.id) }"
                      />
                    </button>
                    <button
                      type="button"
                      class="rounded-lg p-1.5 text-ink-secondary transition-colors hover:bg-theme-700 hover:text-theme-200"
                      title="Edit"
                      aria-label="Edit"
                      @click.stop="openCronJob(job)"
                    >
                      <Icon
                        icon="lucide:pencil"
                        class="h-4 w-4"
                      />
                    </button>
                    <button
                      type="button"
                      class="rounded-lg p-1.5 text-ink-secondary transition-colors hover:bg-sky-500/10 hover:text-status-info disabled:opacity-40"
                      title="Duplicate scheduled job"
                      aria-label="Duplicate scheduled job"
                      :disabled="duplicatingNow.has(job.id)"
                      @click.stop="duplicateCronJob(job)"
                    >
                      <Icon
                        :icon="duplicatingNow.has(job.id) ? 'lucide:loader-2' : 'lucide:copy-plus'"
                        class="h-4 w-4"
                        :class="{ 'animate-spin': duplicatingNow.has(job.id) }"
                      />
                    </button>
                    <button
                      type="button"
                      class="rounded-lg p-1.5 text-ink-secondary transition-colors hover:bg-red-500/10 hover:text-status-danger"
                      title="Delete"
                      aria-label="Delete"
                      @click.stop="confirmDeleteCron(job)"
                    >
                      <Icon
                        icon="lucide:trash-2"
                        class="h-4 w-4"
                      />
                    </button>
                  </div>
                </div>

                <!-- Enable: top right below lg, last column from lg on -->
                <div class="col-start-4 row-start-1 flex items-center lg:col-start-auto lg:row-start-auto lg:h-full lg:border-l lg:border-theme-700/70 lg:pl-4">
                  <ToggleSwitch
                    :model-value="job.enabled"
                    :label="job.enabled ? `Pause ${job.name}` : `Enable ${job.name}`"
                    size="sm"
                    color="emerald"
                    :title="job.enabled ? 'Pause scheduled job' : 'Enable scheduled job'"
                    @update:model-value="toggleCronJob(job.id, !job.enabled)"
                    @click.stop
                  />
                </div>
              </li>
            </ul>
          </section>
        </div>
      </template>
    </div>

    <!-- Add Cron Job Dialog (simplified) -->
    <Teleport to="body">
      <div
        v-if="showAddCron"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        @click.self="showAddCron = false"
      >
        <div class="w-full max-w-lg bg-theme-900 border border-theme-800 rounded-2xl shadow-2xl p-6 max-h-[90vh] overflow-y-auto">
          <h2 class="text-lg font-semibold text-theme-100 mb-4">
            New Scheduled Job
          </h2>

          <div class="space-y-4">
            <!-- Job name -->
            <div>
              <label class="block text-sm text-ink-secondary mb-1">Name</label>
              <input
                v-model="cronName"
                type="text"
                placeholder="e.g. Daily health check"
                class="w-full px-3 py-2 bg-theme-800 border border-theme-700 rounded-lg text-sm text-theme-200 placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-accent-500"
              >
            </div>

            <!-- Agent picker -->
            <div>
              <label class="block text-sm text-ink-secondary mb-1">Agent</label>
              <AgentSelect
                v-model="cronAgentId"
                :agents="allAgents"
                include-default
                :default-label="cyno.name"
                :default-img-src="cyno.iconUrl"
                agents-group-label="Agents"
                placeholder="Select an agent…"
                max-height="max-h-96"
                size="sm"
              />
            </div>

            <!-- Schedule builder -->
            <div>
              <label class="block text-sm text-ink-secondary mb-2">Schedule</label>
              <CustomSelect
                v-model="dlgFrequencyValue"
                :groups="frequencyGroups"
                placeholder="Select a frequency…"
                placeholder-icon="lucide:calendar-clock"
                size="sm"
                class="mb-3"
              />

              <!-- Every X minutes -->
              <div
                v-if="dlgFrequency === 'minutes'"
                class="flex items-center gap-2 mb-3"
              >
                <span class="text-sm text-ink-secondary">Every</span>
                <select
                  v-model.number="dlgEveryMinutes"
                  class="px-3 py-1.5 bg-theme-800 border border-theme-700 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
                >
                  <option
                    v-for="m in INTERVAL_MINUTES"
                    :key="m"
                    :value="m"
                  >
                    {{ m }}
                  </option>
                </select>
                <span class="text-sm text-ink-secondary">minutes</span>
              </div>

              <!-- Hourly -->
              <div
                v-else-if="dlgFrequency === 'hourly'"
                class="flex items-center gap-2 mb-3"
              >
                <span class="text-sm text-ink-secondary">Every hour at minute</span>
                <select
                  v-model.number="dlgAtMinute"
                  class="px-3 py-1.5 bg-theme-800 border border-theme-700 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
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
                <span class="text-sm text-ink-secondary">Every day at</span>
                <select
                  v-model.number="dlgAtHour"
                  class="px-3 py-1.5 bg-theme-800 border border-theme-700 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
                >
                  <option
                    v-for="h in HOUR_OPTIONS"
                    :key="h"
                    :value="h"
                  >
                    {{ String(h).padStart(2, '0') }}
                  </option>
                </select>
                <span class="text-sm text-ink-secondary">:</span>
                <select
                  v-model.number="dlgAtMinute"
                  class="px-3 py-1.5 bg-theme-800 border border-theme-700 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
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
                <span class="text-sm text-ink-secondary">Every</span>
                <select
                  v-model.number="dlgWeekday"
                  class="px-3 py-1.5 bg-theme-800 border border-theme-700 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
                >
                  <option
                    v-for="(label, i) in WEEKDAYS"
                    :key="i"
                    :value="i"
                  >
                    {{ label }}
                  </option>
                </select>
                <span class="text-sm text-ink-secondary">at</span>
                <select
                  v-model.number="dlgAtHour"
                  class="px-3 py-1.5 bg-theme-800 border border-theme-700 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
                >
                  <option
                    v-for="h in HOUR_OPTIONS"
                    :key="h"
                    :value="h"
                  >
                    {{ String(h).padStart(2, '0') }}
                  </option>
                </select>
                <span class="text-sm text-ink-secondary">:</span>
                <select
                  v-model.number="dlgAtMinute"
                  class="px-3 py-1.5 bg-theme-800 border border-theme-700 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
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
                <span class="text-sm text-ink-secondary">On day</span>
                <select
                  v-model.number="dlgMonthDay"
                  class="px-3 py-1.5 bg-theme-800 border border-theme-700 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
                >
                  <option
                    v-for="d in 28"
                    :key="d"
                    :value="d"
                  >
                    {{ d }}
                  </option>
                </select>
                <span class="text-sm text-ink-secondary">at</span>
                <select
                  v-model.number="dlgAtHour"
                  class="px-3 py-1.5 bg-theme-800 border border-theme-700 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
                >
                  <option
                    v-for="h in HOUR_OPTIONS"
                    :key="h"
                    :value="h"
                  >
                    {{ String(h).padStart(2, '0') }}
                  </option>
                </select>
                <span class="text-sm text-ink-secondary">:</span>
                <select
                  v-model.number="dlgAtMinute"
                  class="px-3 py-1.5 bg-theme-800 border border-theme-700 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
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
                  class="w-full px-3 py-1.5 bg-theme-800 border border-theme-700 rounded-lg text-sm text-theme-200 placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-accent-500 font-mono"
                >
                <p class="text-[11px] text-ink-faint mt-1">
                  Standard cron: minute hour day-of-month month day-of-week
                </p>
              </div>

              <!-- Schedule summary -->
              <div class="flex items-center gap-2 px-3 py-2 rounded-lg bg-theme-800/50 border border-theme-800">
                <Icon
                  icon="lucide:calendar-clock"
                  class="w-3.5 h-3.5 text-status-info shrink-0"
                />
                <span class="text-xs text-theme-300">{{ dlgHumanReadable }}</span>
                <code class="ml-auto text-[11px] text-ink-faint font-mono">{{ dlgGeneratedExpr }}</code>
              </div>
            </div>

            <!-- Prompt -->
            <div>
              <label
                for="new-scheduled-job-instructions"
                class="block text-sm text-ink-secondary mb-1"
              >Instructions <span class="text-ink-faint">(optional)</span></label>
              <textarea
                id="new-scheduled-job-instructions"
                v-model="cronPrompt"
                rows="3"
                placeholder="Describe what the agent should do on each run…"
                aria-describedby="new-scheduled-job-instructions-hint"
                class="w-full bg-theme-800 border border-theme-700 text-theme-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500 resize-none"
              />
              <p
                id="new-scheduled-job-instructions-hint"
                class="mt-1 text-xs text-ink-muted"
              >
                Without instructions, the agent follows its own system prompt.
              </p>
            </div>
          </div>

          <p
            v-if="createError"
            class="mt-4 rounded-lg border border-red-400/25 bg-red-400/10 px-3 py-2 text-sm text-status-danger"
            role="alert"
          >
            {{ createError }}
          </p>

          <!-- Actions -->
          <div class="flex justify-end gap-3 mt-6">
            <button
              class="px-4 py-2 text-sm text-ink-secondary hover:text-theme-200 transition-colors"
              @click="showAddCron = false"
            >
              Cancel
            </button>
            <button
              :disabled="!dlgGeneratedExpr.trim() || cronSaving"
              class="px-4 py-2 rounded-lg accent-action bg-accent-600 hover:bg-accent-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-accent-on transition-colors"
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
      title="Delete scheduled job?"
      icon="lucide:trash-2"
      icon-color="red"
      @close="showDeleteConfirm = false"
    >
      <p class="text-ink-secondary leading-relaxed">
        <strong class="text-theme-200">{{ pendingDeleteName }}</strong> will be deleted permanently and will no longer run.
        Conversations from earlier runs are kept.
      </p>
      <template #actions>
        <button
          type="button"
          class="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-sm font-medium text-white transition-colors disabled:cursor-wait disabled:opacity-60"
          :disabled="deletingJob"
          @click="deleteCronJobConfirmed()"
        >
          {{ deletingJob ? 'Deleting…' : 'Delete' }}
        </button>
        <button
          class="px-4 py-2 text-sm text-ink-secondary hover:text-theme-200 transition-colors"
          @click="showDeleteConfirm = false"
        >
          Cancel
        </button>
      </template>
    </ModalDialog>
  </div>
</template>
