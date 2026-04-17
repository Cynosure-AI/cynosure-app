<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { api, type AgentDefinition, type CronJob } from '../../api/client'
import { useProviderStore } from '../../stores/provider.store'
import { Icon } from '@iconify/vue'
import TabBar, { type TabDef } from '../../components/shared/TabBar.vue'
import ModalDialog from '../../components/shared/ModalDialog.vue'
import ToggleSwitch from '../../components/shared/ToggleSwitch.vue'
import CustomSelect, { type SelectOptionGroup } from '../../components/shared/CustomSelect.vue'
import { useProviderLogos } from '../../composables/useProviderLogos'
import {
  parseCronExpr, buildCronExpr, cronToHuman,
  WEEKDAYS, HOUR_OPTIONS, MINUTE_OPTIONS, INTERVAL_MINUTES, FREQUENCY_OPTIONS,
  type CronFrequency
} from '../../composables/useCronHuman'

const cronJobs = ref<CronJob[]>([])
const allAgents = ref<AgentDefinition[]>([])
const loading = ref(true)
const activeTab = ref<'cron'>('cron')
let pollTimer: ReturnType<typeof setInterval> | undefined

const providerStore = useProviderStore()

// Dialog state
const showAddCron = ref(false)
const cronName = ref('')
const cronAgentId = ref('')
const cronOneOff = ref(false)
const cronPrompt = ref('')
const cronSaving = ref(false)
const cronModelOverride = ref('')
const cronProviderOverride = ref('')
const cronModels = ref<string[]>([])
const loadingModels = ref(false)

// Schedule builder refs
const dlgFrequency = ref<CronFrequency>('daily')
const dlgEveryMinutes = ref(30)
const dlgAtMinute = ref(0)
const dlgAtHour = ref(9)
const dlgWeekday = ref(1)
const dlgMonthDay = ref(1)
const dlgCustomExpr = ref('')

// Edit mode — stores the cron job ID being edited
const editingJobId = ref<string | null>(null)

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
  dlgFrequency.value = 'daily'
  dlgEveryMinutes.value = 30
  dlgAtMinute.value = 0
  dlgAtHour.value = 9
  dlgWeekday.value = 1
  dlgMonthDay.value = 1
  dlgCustomExpr.value = ''
  cronOneOff.value = false
  cronPrompt.value = ''
  editingJobId.value = null
  cronModelOverride.value = ''
  cronProviderOverride.value = ''
  cronModels.value = []
}

function loadDlgFromExpr(expr: string) {
  const p = parseCronExpr(expr)
  dlgFrequency.value = p.frequency
  dlgEveryMinutes.value = p.everyMinutes
  dlgAtMinute.value = p.atMinute
  dlgAtHour.value = p.atHour
  dlgWeekday.value = p.weekday
  dlgMonthDay.value = p.monthDay
  dlgCustomExpr.value = p.customExpr
}

async function openAddCronDialog() {
  allAgents.value = await api.agents.list()
  resetDlg()
  showAddCron.value = true
}

async function openEditCronDialog(job: CronJob) {
  allAgents.value = await api.agents.list()
  resetDlg()
  editingJobId.value = job.id
  cronName.value = job.name || ''
  cronAgentId.value = job.agentId
  loadDlgFromExpr(job.schedule)
  cronOneOff.value = job.oneOff
  cronPrompt.value = job.prompt || ''
  cronModelOverride.value = job.modelOverride || ''
  cronProviderOverride.value = job.providerOverride || ''
  showAddCron.value = true
}

async function saveCronJob() {
  const expr = dlgGeneratedExpr.value
  if (!expr.trim()) return
  cronSaving.value = true
  try {
    if (editingJobId.value) {
      // Update existing
      await api.cronJobs.update(editingJobId.value, {
        name: cronName.value.trim(),
        schedule: expr.trim(),
        prompt: cronPrompt.value,
        oneOff: cronOneOff.value,
        modelOverride: cronModelOverride.value,
        providerOverride: cronProviderOverride.value,
      })
    } else {
      // Create new
      if (!cronAgentId.value) return
      await api.cronJobs.create({
        name: cronName.value.trim(),
        agentId: cronAgentId.value,
        schedule: expr.trim(),
        prompt: cronPrompt.value,
        enabled: true,
        oneOff: cronOneOff.value,
        modelOverride: cronModelOverride.value,
        providerOverride: cronProviderOverride.value,
      })
    }
    showAddCron.value = false
    await loadSchedules()
  } finally {
    cronSaving.value = false
  }
}

async function toggleCronJob(jobId: string, enabled: boolean) {
  await api.cronJobs.update(jobId, { enabled })
  await loadSchedules()
}

async function deleteCronJobConfirmed() {
  if (!pendingDeleteId.value) return
  await api.cronJobs.delete(pendingDeleteId.value)
  showDeleteConfirm.value = false
  pendingDeleteId.value = null
  await loadSchedules()
}

const showDeleteConfirm = ref(false)
const pendingDeleteId = ref<string | null>(null)
const pendingDeleteName = ref('')

function confirmDeleteCron(job: CronJob) {
  pendingDeleteId.value = job.id
  pendingDeleteName.value = job.agentName
  showDeleteConfirm.value = true
}

const tabs: TabDef<'cron'>[] = [
  { value: 'cron', label: 'Cron Jobs', icon: 'lucide:clock' }
]

// ─── Model override helpers ──────────────────────────────

/** Resolve the effective provider ID for the currently selected agent */
const effectiveProviderId = computed(() => {
  if (cronProviderOverride.value) return cronProviderOverride.value
  const agent = allAgents.value.find(a => a.id === cronAgentId.value)
  return agent?.providerId || providerStore.lastUsedProviderId
})

const effectiveDefaultModel = computed(() => {
  const agent = allAgents.value.find(a => a.id === cronAgentId.value)
  const agentModel = agent?.model
  const provider = providerStore.providers.find(p => p.id === effectiveProviderId.value)
  return agentModel || provider?.defaultModel || ''
})

async function fetchCronModels(): Promise<void> {
  const pid = cronProviderOverride.value || effectiveProviderId.value
  if (!pid) { cronModels.value = []; return }
  loadingModels.value = true
  try {
    cronModels.value = await providerStore.listModels(pid, 'llm')
  } catch {
    cronModels.value = []
  } finally {
    loadingModels.value = false
  }
}

function onCronProviderChange(pid: string): void {
  cronProviderOverride.value = pid
  cronModelOverride.value = ''
  cronModels.value = []
  if (pid) fetchCronModels()
}

const { logoUrl } = useProviderLogos()

const cronProviderGroups = computed((): SelectOptionGroup[] => [{
  options: [
    { value: '', label: 'Agent default', iconName: 'lucide:settings' },
    ...providerStore.providers.map(p => ({
      value: p.id,
      label: p.name,
      imgSrc: logoUrl(p.type),
    })),
  ],
}])

const cronModelGroups = computed((): SelectOptionGroup[] => [{
  options: [
    { value: '', label: effectiveDefaultModel.value ? `Default (${effectiveDefaultModel.value})` : 'Provider default', iconName: 'lucide:settings' },
    ...cronModels.value.map(m => ({ value: m, label: m })),
  ],
}])

// When dialog opens with an existing provider override, fetch its models
watch(showAddCron, (open) => {
  if (open && (cronProviderOverride.value || effectiveProviderId.value)) {
    fetchCronModels()
  }
})

const tabsWithBadges = computed(() =>
  tabs.map(t => ({
    ...t,
    badge: cronJobs.value.length
  }))
)

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

async function loadSchedules() {
  try {
    cronJobs.value = await api.cronJobs.list()
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
    <div class="max-w-3xl mx-auto py-8 px-6">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold text-zinc-100">
            Scheduled Jobs
          </h1>
          <p class="text-sm text-zinc-500 mt-1">
            Cron jobs running on recurring schedules
          </p>
        </div>
        <button
          v-if="activeTab === 'cron'"
          class="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-sm font-medium text-white transition-colors"
          @click="openAddCronDialog"
        >
          <Icon
            icon="lucide:plus"
            class="w-4 h-4"
          />
          Add Cron Job
        </button>
      </div>

      <!-- Tabs -->
      <TabBar
        v-model="activeTab"
        :tabs="tabsWithBadges"
        class="mb-6"
      />

      <!-- Loading -->
      <div
        v-if="loading"
        class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-12 text-center"
      >
        <Icon
          icon="lucide:loader-2"
          class="w-8 h-8 text-zinc-500 animate-spin mx-auto mb-3"
        />
        <p class="text-sm text-zinc-500">
          Loading schedules…
        </p>
      </div>

      <!-- ====================== CRON TAB ====================== -->
      <template v-else-if="activeTab === 'cron'">
        <!-- Empty -->
        <div
          v-if="cronJobs.length === 0"
          class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-12 text-center"
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
        </div>

        <div
          v-else
          class="space-y-2"
        >
          <div
            v-for="job in cronJobs"
            :key="job.id"
            class="flex items-center gap-4 px-5 py-4 rounded-xl border bg-zinc-900/50 group"
            :class="job.enabled ? 'border-zinc-800' : 'border-zinc-800/50 opacity-60'"
          >
            <div class="shrink-0">
              <img
                v-if="job.agentIconUrl"
                :src="job.agentIconUrl"
                :alt="job.agentName"
                class="w-10 h-10 rounded-xl object-cover"
              >
              <div
                v-else
                class="w-10 h-10 rounded-xl bg-zinc-800 flex items-center justify-center"
              >
                <Icon
                  icon="lucide:bot"
                  class="w-5 h-5 text-zinc-500"
                />
              </div>
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-0.5">
                <span class="text-sm font-medium text-zinc-200 truncate">{{ job.name || job.agentName }}</span>
                <span
                  v-if="job.name"
                  class="text-xs text-zinc-500 truncate"
                >
                  {{ job.agentName }}
                </span>
                <span
                  v-if="job.oneOff"
                  class="text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 shrink-0"
                >
                  One-off
                </span>
                <span
                  v-if="job.modelOverride"
                  class="text-[10px] font-medium px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 shrink-0 truncate max-w-35"
                  :title="job.modelOverride"
                >
                  {{ job.modelOverride }}
                </span>
              </div>
              <div class="flex items-center gap-2 text-xs text-zinc-500">
                <Icon
                  icon="lucide:clock"
                  class="w-3 h-3"
                  :class="job.enabled ? 'text-sky-400' : 'text-zinc-600'"
                />
                <span>{{ cronToHuman(job.schedule) }}</span>

                <template v-if="job.enabled && job.nextRunAt && !job.isRunning">
                  <span class="text-zinc-700">·</span>
                  <span class="text-emerald-400/80 tabular-nums">
                    <Icon
                      icon="lucide:timer"
                      class="w-3 h-3 inline -mt-px mr-0.5"
                    />{{ formatCountdown(job.nextRunAt) }}
                  </span>
                </template>
              </div>
              <div
                v-if="job.prompt"
                class="text-xs text-zinc-600 mt-0.5 truncate max-w-sm"
              >
                {{ job.prompt }}
              </div>
            </div>
            <div class="shrink-0 flex items-center gap-3">
              <!-- Edit / Delete (visible on hover) -->
              <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  class="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 transition-colors"
                  title="Edit"
                  @click="openEditCronDialog(job)"
                >
                  <Icon
                    icon="lucide:pencil"
                    class="w-3.5 h-3.5"
                  />
                </button>
                <button
                  class="p-1.5 rounded-lg hover:bg-red-500/10 text-zinc-500 hover:text-red-400 transition-colors"
                  title="Delete"
                  @click="confirmDeleteCron(job)"
                >
                  <Icon
                    icon="lucide:trash-2"
                    class="w-3.5 h-3.5"
                  />
                </button>
              </div>

              <!-- Enable/Disable toggle -->
              <ToggleSwitch
                :model-value="job.enabled"
                size="sm"
                color="emerald"
                :title="job.enabled ? 'Pause cron job' : 'Enable cron job'"
                @update:model-value="toggleCronJob(job.id, !job.enabled)"
              />

              <!-- Status -->
              <template v-if="job.isRunning">
                <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span class="text-xs text-emerald-400">Executing</span>
              </template>
              <template v-else-if="job.enabled">
                <span class="w-2 h-2 rounded-full bg-sky-500" />
                <span class="text-xs text-sky-400">Scheduled</span>
              </template>
              <template v-else>
                <span class="w-2 h-2 rounded-full bg-zinc-600" />
                <span class="text-xs text-zinc-500">Paused</span>
              </template>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- Add Cron Job Dialog -->
    <Teleport to="body">
      <div
        v-if="showAddCron"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        @click.self="showAddCron = false"
      >
        <div class="w-full max-w-lg md:max-w-4xl bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl p-6 max-h-[90vh] overflow-y-auto">
          <h2 class="text-lg font-semibold text-zinc-100 mb-4">
            {{ editingJobId ? 'Edit Cron Job' : 'Add Cron Job' }}
          </h2>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-0">
            <!-- ═══ Left column: Identity + Schedule ═══ -->
            <div>
              <!-- Job name -->
              <label class="block text-sm text-zinc-400 mb-1">Name</label>
              <input
                v-model="cronName"
                type="text"
                placeholder="e.g. Daily health check"
                class="w-full px-3 py-2 mb-4 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >

              <!-- Agent picker -->
              <label class="block text-sm text-zinc-400 mb-1">Agent</label>
              <select
                v-model="cronAgentId"
                :disabled="!!editingJobId"
                class="w-full px-3 py-2 mb-4 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
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

              <!-- Schedule builder -->
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
              <div class="flex items-center gap-2 px-3 py-2 mb-4 rounded-lg bg-zinc-800/50 border border-zinc-800">
                <Icon
                  icon="lucide:calendar-clock"
                  class="w-3.5 h-3.5 text-sky-400 shrink-0"
                />
                <span class="text-xs text-zinc-300">{{ dlgHumanReadable }}</span>
                <code class="ml-auto text-[11px] text-zinc-600 font-mono">{{ dlgGeneratedExpr }}</code>
              </div>

              <!-- One-off -->
              <label class="flex items-center gap-2 mb-4 md:mb-0 cursor-pointer select-none">
                <ToggleSwitch
                  v-model="cronOneOff"
                  size="md"
                  color="amber"
                />
                <span class="text-sm text-zinc-300">One-off (auto-disable after first run)</span>
              </label>
            </div>

            <!-- ═══ Right column: Model Override + Prompt ═══ -->
            <div class="flex flex-col">
              <!-- Model / Provider Override -->
              <label class="block text-sm text-zinc-400 mb-1">Model Override</label>
              <p class="text-[11px] text-zinc-600 mb-2">
                Override the agent's default provider or model for this cron job.
              </p>
              <div class="grid grid-cols-2 gap-2 mb-4">
                <div>
                  <label class="block text-[11px] text-zinc-500 mb-0.5">Provider</label>
                  <CustomSelect
                    :model-value="cronProviderOverride"
                    :groups="cronProviderGroups"
                    placeholder="Agent default"
                    placeholder-icon="lucide:settings"
                    @update:model-value="onCronProviderChange($event)"
                  />
                </div>
                <div>
                  <label class="block text-[11px] text-zinc-500 mb-0.5">Model</label>
                  <div class="flex items-center gap-1">
                    <div class="flex-1 min-w-0">
                      <CustomSelect
                        v-model="cronModelOverride"
                        :groups="cronModelGroups"
                        :placeholder="effectiveDefaultModel ? `Default (${effectiveDefaultModel})` : 'Provider default'"
                        placeholder-icon="lucide:settings"
                      />
                    </div>
                    <button
                      :disabled="loadingModels"
                      class="p-1.5 text-zinc-500 hover:text-zinc-300 disabled:opacity-40 rounded-lg transition-colors shrink-0"
                      title="Refresh available models"
                      @click="fetchCronModels"
                    >
                      <Icon
                        :icon="loadingModels ? 'lucide:loader-2' : 'lucide:refresh-cw'"
                        class="w-3.5 h-3.5"
                        :class="{ 'animate-spin': loadingModels }"
                      />
                    </button>
                  </div>
                </div>
              </div>

              <!-- Cron prompt -->
              <label class="block text-sm text-zinc-400 mb-1">Cron Prompt</label>
              <textarea
                v-model="cronPrompt"
                placeholder="Describe what the agent should do on each cron trigger…"
                class="w-full px-3 py-2 mb-4 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y font-mono flex-1 min-h-32"
              />
            </div>
          </div>

          <!-- Actions (full width) -->
          <div class="flex justify-end gap-3">
            <button
              class="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
              @click="showAddCron = false"
            >
              Cancel
            </button>
            <button
              :disabled="!(editingJobId || cronAgentId) || !dlgGeneratedExpr.trim() || cronSaving"
              class="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors"
              @click="saveCronJob"
            >
              {{ cronSaving ? 'Saving…' : editingJobId ? 'Save Changes' : 'Save & Enable' }}
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
