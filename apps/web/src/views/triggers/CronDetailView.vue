<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../../api/client'
import type { AgentDefinition, CronJob } from '../../api/types'
import { useProviderStore } from '../../stores/provider.store'
import { Icon } from '@iconify/vue'
import CustomSelect, { type SelectOptionGroup } from '../../components/shared/CustomSelect.vue'
import { useProviderLogos } from '../../composables/useProviderLogos'
import {
  parseCronExpr, buildCronExpr, cronToHuman,
  WEEKDAYS, HOUR_OPTIONS, MINUTE_OPTIONS, INTERVAL_MINUTES, FREQUENCY_OPTIONS,
  type CronFrequency
} from '../../utils/cron-helpers'
import ToggleSwitch from '@/components/shared/ToggleSwitch.vue'

const route = useRoute()
const router = useRouter()
const providerStore = useProviderStore()
const { logoUrl } = useProviderLogos()

const job = ref<CronJob | null>(null)
const allAgents = ref<AgentDefinition[]>([])
const loading = ref(true)
const saving = ref(false)
const saveMessage = ref('')
const promptTextarea = ref<HTMLTextAreaElement | null>(null)

function resizePrompt() {
  nextTick(() => {
    const el = promptTextarea.value
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  })
}

// Editable fields
const cronName = ref('')
const cronAgentId = ref('')
const cronPrompt = ref('')
const cronOneOff = ref(false)
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

const jobId = computed(() => route.params.id as string)

const dlgParts = computed(() => ({
  frequency: dlgFrequency.value, everyMinutes: dlgEveryMinutes.value,
  atMinute: dlgAtMinute.value, atHour: dlgAtHour.value,
  weekday: dlgWeekday.value, monthDay: dlgMonthDay.value, customExpr: dlgCustomExpr.value
}))
const dlgGeneratedExpr = computed(() => buildCronExpr(dlgParts.value))
const dlgHumanReadable = computed(() => cronToHuman(dlgParts.value))

function populateFields(j: CronJob) {
  cronName.value = j.name || ''
  cronAgentId.value = j.agentId
  cronPrompt.value = j.prompt || ''
  cronOneOff.value = j.oneOff
  cronModelOverride.value = j.modelOverride || ''
  cronProviderOverride.value = j.providerOverride || ''

  const p = parseCronExpr(j.schedule)
  dlgFrequency.value = p.frequency
  dlgEveryMinutes.value = p.everyMinutes
  dlgAtMinute.value = p.atMinute
  dlgAtHour.value = p.atHour
  dlgWeekday.value = p.weekday
  dlgMonthDay.value = p.monthDay
  dlgCustomExpr.value = p.customExpr
}

async function loadJob() {
  loading.value = true
  try {
    const [jobs, agents] = await Promise.all([
      api.cronJobs.list(),
      api.agents.list(),
    ])
    allAgents.value = agents
    const found = jobs.find(j => j.id === jobId.value)
    if (!found) {
      router.push('/triggers/cron')
      return
    }
    job.value = found
    populateFields(found)
  } finally {
    loading.value = false
  }
}

async function save() {
  if (!job.value) return
  const expr = dlgGeneratedExpr.value
  if (!expr.trim()) return

  saving.value = true
  try {
    await api.cronJobs.update(jobId.value, {
      name: cronName.value.trim(),
      agentId: cronAgentId.value,
      schedule: expr.trim(),
      prompt: cronPrompt.value,
      oneOff: cronOneOff.value,
      modelOverride: cronModelOverride.value,
      providerOverride: cronProviderOverride.value,
    })
    saveMessage.value = 'Saved'
    setTimeout(() => saveMessage.value = '', 2000)

    const jobs = await api.cronJobs.list()
    const found = jobs.find(j => j.id === jobId.value)
    if (found) job.value = found
  } finally {
    saving.value = false
  }
}

// ─── Model override helpers ──────────────────────────────

const effectiveProviderId = computed(() => {
  if (cronProviderOverride.value) return cronProviderOverride.value
  if (!job.value) return providerStore.lastUsedProviderId
  const agent = allAgents.value.find(a => a.id === cronAgentId.value)
  return agent?.providerId || providerStore.lastUsedProviderId
})

const effectiveDefaultModel = computed(() => {
  if (!job.value) return ''
  const agent = allAgents.value.find(a => a.id === cronAgentId.value)
  const agentModel = agent?.model
  const provider = providerStore.providers.find(p => p.id === effectiveProviderId.value)
  return agentModel || provider?.defaultModel || ''
})

async function fetchModels(): Promise<void> {
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

function onProviderChange(pid: string): void {
  cronProviderOverride.value = pid
  cronModelOverride.value = ''
  cronModels.value = []
  if (pid) fetchModels()
}

watch(() => job.value, (j) => {
  if (j && (cronProviderOverride.value || effectiveProviderId.value)) {
    fetchModels()
  }
})

// ─── CustomSelect groups ─────────────────────────────────

const agentGroups = computed((): SelectOptionGroup[] => [{
  options: allAgents.value.map(a => ({
    value: a.id,
    label: a.name,
    imgSrc: a.iconUrl || undefined,
    iconName: a.iconUrl ? undefined : 'lucide:bot',
  }))
}])

const providerGroups = computed((): SelectOptionGroup[] => [{
  options: [
    { value: '', label: 'Agent default', iconName: 'lucide:settings' },
    ...providerStore.providers.map(p => ({
      value: p.id,
      label: p.name,
      imgSrc: logoUrl(p.type),
    })),
  ],
}])

const modelGroups = computed((): SelectOptionGroup[] => [{
  options: [
    { value: '', label: effectiveDefaultModel.value ? `Default (${effectiveDefaultModel.value})` : 'Provider default', iconName: 'lucide:settings' },
    ...cronModels.value.map(m => ({ value: m, label: m })),
  ],
}])

onMounted(loadJob)
watch(cronPrompt, resizePrompt, { immediate: true })
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-3xl mx-auto py-8 px-6">
      <!-- Loading -->
      <div
        v-if="loading"
        class="text-center py-12 text-zinc-400"
      >
        Loading…
      </div>

      <template v-else-if="job">
        <!-- Back + Title -->
        <div class="flex items-center justify-between mb-6">
          <div class="flex items-center gap-3">
            <button
              class="p-1.5 text-zinc-500 hover:text-zinc-300 transition-colors"
              @click="router.push('/triggers/cron')"
            >
              <Icon
                icon="lucide:arrow-left"
                class="w-5 h-5"
              />
            </button>
            <div class="w-9 h-9 rounded-xl bg-zinc-800 flex items-center justify-center shrink-0 overflow-hidden">
              <img
                v-if="job.agentIconUrl"
                :src="job.agentIconUrl"
                class="w-full h-full object-cover"
              >
              <Icon
                v-else
                icon="lucide:clock"
                class="w-5 h-5 text-zinc-400"
              />
            </div>
            <div>
              <h1 class="text-2xl font-bold text-zinc-100">
                {{ job.name || 'Unnamed cron job' }}
              </h1>
              <p class="text-sm text-zinc-400 mt-0.5">
                Agent: {{ job.agentName }}
              </p>
            </div>
          </div>

          <div class="flex items-center gap-2">
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
            <span
              v-if="saveMessage"
              class="text-sm text-green-400"
            >{{ saveMessage }}</span>
            <button
              class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
              :disabled="saving || !dlgGeneratedExpr.trim()"
              @click="save"
            >
              {{ saving ? 'Saving…' : 'Save Changes' }}
            </button>
          </div>
        </div>

        <!-- Form -->
        <div class="space-y-6">
          <!-- Name -->
          <div>
            <label class="block text-xs text-zinc-400 mb-1">Name</label>
            <input
              v-model="cronName"
              type="text"
              placeholder="e.g. Daily health check"
              class="w-full bg-zinc-800 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
          </div>

          <!-- Agent -->
          <div>
            <label class="block text-xs text-zinc-400 mb-1">Agent</label>
            <CustomSelect
              v-model="cronAgentId"
              :groups="agentGroups"
              placeholder="Select an agent…"
              placeholder-icon="lucide:bot"
            />
          </div>

          <!-- Schedule builder -->
          <div>
            <label class="block text-xs text-zinc-400 mb-2">Schedule</label>
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

          <!-- One-off -->
          <label class="flex items-center gap-2 cursor-pointer select-none">
            <ToggleSwitch
              v-model="cronOneOff"
              size="md"
              color="amber"
            />
            <span class="text-sm text-zinc-300">One-off (auto-disable after first run)</span>
          </label>

          <!-- Provider/Model overrides -->
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label class="block text-xs text-zinc-400 mb-1">Provider override</label>
              <CustomSelect
                :model-value="cronProviderOverride"
                :groups="providerGroups"
                placeholder="Agent default"
                placeholder-icon="lucide:settings"
                @update:model-value="onProviderChange($event)"
              />
            </div>
            <div>
              <label class="block text-xs text-zinc-400 mb-1">Model override</label>
              <div class="flex items-center gap-1">
                <div class="flex-1 min-w-0">
                  <CustomSelect
                    v-model="cronModelOverride"
                    :groups="modelGroups"
                    :placeholder="effectiveDefaultModel ? `Default (${effectiveDefaultModel})` : 'Provider default'"
                    placeholder-icon="lucide:settings"
                  />
                </div>
                <button
                  :disabled="loadingModels"
                  class="p-1.5 text-zinc-500 hover:text-zinc-300 disabled:opacity-40 rounded-lg transition-colors shrink-0"
                  title="Refresh available models"
                  @click="fetchModels"
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

          <!-- Prompt -->
          <div>
            <label class="block text-xs text-zinc-400 mb-1">Cron Prompt</label>
            <textarea
              ref="promptTextarea"
              v-model="cronPrompt"
              placeholder="Describe what the agent should do on each cron trigger…"
              class="w-full bg-zinc-800 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 resize-vertical overflow-hidden"
              style="min-height: 5rem"
              @input="resizePrompt"
            />
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
