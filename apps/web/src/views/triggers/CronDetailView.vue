<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../../api/client";
import type {
  AgentDefinition,
  ChannelDefinition,
  CronJob,
} from "../../api/types";
import { Icon } from "@iconify/vue";
import AgentSelect from "../../components/shared/AgentSelect.vue";
import BaseCard from "../../components/shared/BaseCard.vue";
import HoverMenu from "../../components/shared/HoverMenu.vue";
import {
  parseCronExpr,
  buildCronExpr,
  cronToHuman,
  WEEKDAYS,
  HOUR_OPTIONS,
  MINUTE_OPTIONS,
  INTERVAL_MINUTES,
  FREQUENCY_OPTIONS,
  type CronFrequency,
} from "../../utils/cron-helpers";
import ToggleSwitch from "@/components/shared/ToggleSwitch.vue";

const route = useRoute();
const router = useRouter();

const job = ref<CronJob | null>(null);
const allAgents = ref<AgentDefinition[]>([]);
const allChannels = ref<ChannelDefinition[]>([]);
const loading = ref(true);
const saving = ref(false);
const saveMessage = ref("");
const promptTextarea = ref<HTMLTextAreaElement | null>(null);

function resizePrompt() {
  nextTick(() => {
    const el = promptTextarea.value;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  });
}

// Editable fields
const cronName = ref("");
const cronAgentId = ref("");
const cronPrompt = ref("");
const cronEnabled = ref(true);
const cronOneOff = ref(false);
const cronOutputChannelId = ref("");
const cronNotificationMode = ref<"always" | "conditional">("always");
const cronNotificationCondition = ref("");

// Schedule builder refs
const dlgFrequency = ref<CronFrequency>("daily");
const dlgEveryMinutes = ref(30);
const dlgAtMinute = ref(0);
const dlgAtHour = ref(9);
const dlgWeekday = ref(1);
const dlgMonthDay = ref(1);
const dlgCustomExpr = ref("");

const jobId = computed(() => route.params.id as string);

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const dlgParts = computed(() => ({
  frequency: dlgFrequency.value,
  everyMinutes: dlgEveryMinutes.value,
  atMinute: dlgAtMinute.value,
  atHour: dlgAtHour.value,
  weekday: dlgWeekday.value,
  monthDay: dlgMonthDay.value,
  customExpr: dlgCustomExpr.value,
}));
const dlgGeneratedExpr = computed(() => buildCronExpr(dlgParts.value));
const dlgHumanReadable = computed(() => cronToHuman(dlgParts.value));
const selectedFrequencyOption = computed(() =>
  FREQUENCY_OPTIONS.find((opt) => opt.value === dlgFrequency.value) || FREQUENCY_OPTIONS[0]
);
const stateMeta = computed(() => {
  if (job.value?.isRunning) {
    return {
      label: "Executing",
      description: "A run is currently in progress.",
      icon: "lucide:loader-2",
      color: "text-emerald-400",
      bg: "bg-emerald-500/10",
      border: "border-emerald-500/25",
      spin: true,
    };
  }
  if (cronEnabled.value) {
    return {
      label: "Scheduled",
      description: "This job is enabled and will run on schedule.",
      icon: "lucide:calendar-check",
      color: "text-sky-400",
      bg: "bg-sky-500/10",
      border: "border-sky-500/25",
      spin: false,
    };
  }
  return {
    label: "Paused",
    description: "This job is disabled and will not run automatically.",
    icon: "lucide:pause-circle",
    color: "text-theme-500",
    bg: "bg-theme-800",
    border: "border-theme-700",
    spin: false,
  };
});

function populateFields(j: CronJob) {
  cronName.value = j.name || "";
  cronAgentId.value = j.agentId;
  cronPrompt.value = j.prompt || "";
  cronEnabled.value = j.enabled;
  cronOneOff.value = j.oneOff;
  cronOutputChannelId.value = j.outputChannelId || "";
  cronNotificationMode.value = j.notificationMode === "conditional" ? "conditional" : "always";
  cronNotificationCondition.value = j.notificationCondition || "";

  const p = parseCronExpr(j.schedule);
  dlgFrequency.value = p.frequency;
  dlgEveryMinutes.value = p.everyMinutes;
  dlgAtMinute.value = p.atMinute;
  dlgAtHour.value = p.atHour;
  dlgWeekday.value = p.weekday;
  dlgMonthDay.value = p.monthDay;
  dlgCustomExpr.value = p.customExpr;
}

async function loadJob() {
  loading.value = true;
  try {
    const [jobs, agents, channels] = await Promise.all([
      api.cronJobs.list(),
      api.agents.list(),
      api.channels.list(),
    ]);
    allAgents.value = agents;
    allChannels.value = channels;
    const found = jobs.find((j) => j.id === jobId.value);
    if (!found) {
      router.push("/cron");
      return;
    }
    job.value = found;
    populateFields(found);
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!job.value) return;
  const expr = dlgGeneratedExpr.value;
  if (!expr.trim()) return;

  saving.value = true;
  try {
    await api.cronJobs.update(jobId.value, {
      name: cronName.value.trim(),
      ...(job.value.agentId ? { agentId: cronAgentId.value } : {}),
      schedule: expr.trim(),
      prompt: cronPrompt.value,
      enabled: cronEnabled.value,
      oneOff: cronOneOff.value,
      outputChannelId: cronOutputChannelId.value,
      notificationMode: cronNotificationMode.value,
      notificationCondition: cronNotificationCondition.value,
    });
    saveMessage.value = "Saved";
    setTimeout(() => (saveMessage.value = ""), 2000);

    const jobs = await api.cronJobs.list();
    const found = jobs.find((j) => j.id === jobId.value);
    if (found) job.value = found;
  } finally {
    saving.value = false;
  }
}

onMounted(loadJob);
watch(cronPrompt, resizePrompt, { immediate: true });
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-3xl mx-auto py-8 px-6">
      <!-- Loading -->
      <div
        v-if="loading"
        class="text-center py-12 text-theme-400"
      >
        Loading…
      </div>

      <template v-else-if="job">
        <!-- Back + Title -->
        <div class="flex items-center justify-between mb-6">
          <div class="flex items-center gap-3">
            <button
              class="p-1.5 text-theme-500 hover:text-theme-300 transition-colors"
              @click="router.push('/cron')"
            >
              <Icon
                icon="lucide:arrow-left"
                class="w-5 h-5"
              />
            </button>
            <button
              type="button"
              class="w-9 h-9 rounded-xl bg-linear-to-br from-sky-500/20 to-indigo-500/20 flex items-center justify-center shrink-0 overflow-hidden hover:ring-2 hover:ring-accent-500/60 transition-shadow"
              :title="`Open ${job.agentName} agent details`"
              :aria-label="`Open ${job.agentName} agent details`"
              @click="router.push(`/agents/${job.agentId}`)"
            >
              <img
                v-if="job.agentIconUrl"
                :src="job.agentIconUrl"
                class="w-full h-full object-cover"
              >
              <Icon
                v-else
                icon="lucide:clock"
                class="w-5 h-5 text-sky-400"
              />
            </button>
            <div>
              <h1 class="text-2xl font-bold text-theme-100">
                {{ job.name || "Unnamed cron job" }}
              </h1>
              <dl class="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-theme-500">
                <div class="flex items-center gap-1">
                  <dt>Created</dt>
                  <dd class="text-theme-400">
                    {{ formatTimestamp(job.createdAt) }}
                  </dd>
                </div>
                <div class="flex items-center gap-1">
                  <dt>Last changed</dt>
                  <dd class="text-theme-400">
                    {{ formatTimestamp(job.updatedAt) }}
                  </dd>
                </div>
              </dl>
            </div>
          </div>

          <div class="flex items-center gap-3">
            <span
              v-if="saveMessage"
              class="text-sm text-green-400"
            >{{ saveMessage }}</span>
            <button
              class="px-4 py-2 bg-accent-600 hover:bg-accent-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
              :disabled="saving || !dlgGeneratedExpr.trim()"
              @click="save"
            >
              {{ saving ? "Saving…" : "Save Changes" }}
            </button>
          </div>
        </div>

        <!-- Form -->
        <div class="space-y-4">
          <!-- Identity: Name + Agent -->
          <BaseCard class="p-5 space-y-4">
            <div class="flex items-center gap-2">
              <Icon
                icon="lucide:tag"
                class="w-4 h-4 text-theme-400"
              />
              <h3 class="text-sm font-medium text-theme-200">
                Identity
              </h3>
            </div>
            <div>
              <label class="block text-xs text-theme-400 mb-1.5">Name</label>
              <input
                v-model="cronName"
                type="text"
                placeholder="e.g. Daily health check"
                class="w-full bg-theme-900 border border-theme-700 text-theme-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500"
              >
            </div>
            <div>
              <label class="block text-xs text-theme-400 mb-1.5">Agent</label>
              <AgentSelect
                v-if="job.agentId"
                v-model="cronAgentId"
                :agents="allAgents"
                placeholder="Select an agent…"
              />
              <div
                v-else
                class="flex items-center gap-2 rounded-lg border border-theme-700 bg-theme-900 px-3 py-2 text-sm text-theme-300"
              >
                <Icon
                  icon="lucide:message-square"
                  class="h-4 w-4 text-accent-400"
                />
                Free Chat configuration
              </div>
            </div>
          </BaseCard>

          <!-- State -->
          <BaseCard class="p-5">
            <div class="space-y-3">
              <div class="flex items-start justify-between gap-4">
                <div class="min-w-0">
                  <div class="flex items-center gap-2 mb-1">
                    <Icon
                      icon="lucide:power"
                      class="w-4 h-4 text-theme-400"
                    />
                    <h3 class="text-sm font-medium text-theme-200">
                      Enabled / State
                    </h3>
                  </div>
                  <p class="text-xs text-theme-500 leading-relaxed">
                    Control whether this cron job runs automatically.
                  </p>
                </div>
                <ToggleSwitch
                  v-model="cronEnabled"
                  label="Enable scheduled job"
                  size="md"
                  color="emerald"
                  class="mt-0.5 shrink-0"
                />
              </div>
              <div
                class="flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2"
                :class="[stateMeta.border, stateMeta.bg]"
              >
                <Icon
                  :icon="stateMeta.icon"
                  class="w-4 h-4 shrink-0"
                  :class="[stateMeta.color, { 'animate-spin': stateMeta.spin }]"
                />
                <div class="min-w-0">
                  <p
                    class="text-sm font-medium leading-tight"
                    :class="stateMeta.color"
                  >
                    {{ stateMeta.label }}
                  </p>
                  <p class="truncate text-[11px] text-theme-500 leading-tight">
                    {{ stateMeta.description }}
                  </p>
                </div>
              </div>
            </div>
          </BaseCard>

          <!-- Schedule -->
          <BaseCard class="p-5">
            <div class="flex items-center gap-2 mb-1">
              <Icon
                icon="lucide:calendar-clock"
                class="w-4 h-4 text-theme-400"
              />
              <h3 class="text-sm font-medium text-theme-200">
                Schedule
              </h3>
            </div>
            <p class="text-xs text-theme-500 leading-relaxed mb-4">
              Define when this job should run. Choose a frequency and configure the timing below.
            </p>

            <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
              <HoverMenu
                placement="below"
                :max-width="240"
                :close-delay="180"
              >
                <template #trigger="{ open, toggle }">
                  <button
                    type="button"
                    class="inline-flex w-full items-center justify-between gap-3 rounded-lg border border-theme-700 bg-theme-900 px-3 py-2 text-sm text-theme-200 transition hover:border-theme-600 hover:bg-theme-800 sm:w-48"
                    aria-haspopup="menu"
                    :aria-expanded="open"
                    @click.stop="toggle"
                  >
                    <span class="inline-flex min-w-0 items-center gap-2">
                      <Icon
                        :icon="selectedFrequencyOption.icon"
                        class="w-4 h-4 shrink-0 text-indigo-400"
                      />
                      <span class="truncate">{{ selectedFrequencyOption.label }}</span>
                    </span>
                    <Icon
                      icon="lucide:chevron-down"
                      class="w-4 h-4 shrink-0 text-theme-500 transition"
                      :class="{ 'rotate-180': open }"
                    />
                  </button>
                </template>

                <template #content="{ close }">
                  <div
                    class="w-56"
                    role="menu"
                    @click.stop
                  >
                    <button
                      v-for="opt in FREQUENCY_OPTIONS"
                      :key="opt.value"
                      type="button"
                      class="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] transition hover:bg-theme-800"
                      :class="
                        dlgFrequency === opt.value
                          ? 'text-accent-400 bg-accent-500/10'
                          : 'text-theme-300 hover:text-theme-100'
                      "
                      @click="dlgFrequency = opt.value; close()"
                    >
                      <Icon
                        :icon="opt.icon"
                        class="w-3.5 h-3.5"
                      />
                      <span class="flex-1">{{ opt.label }}</span>
                      <Icon
                        v-if="dlgFrequency === opt.value"
                        icon="lucide:check"
                        class="w-3.5 h-3.5"
                      />
                    </button>
                  </div>
                </template>
              </HoverMenu>

              <!-- Every X minutes -->
              <div
                v-if="dlgFrequency === 'minutes'"
                class="flex min-w-0 flex-wrap items-center gap-2"
              >
                <span class="text-sm text-theme-400">Every</span>
                <select
                  v-model.number="dlgEveryMinutes"
                  class="px-3 py-1.5 bg-theme-900 border border-theme-700 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
                >
                  <option
                    v-for="m in INTERVAL_MINUTES"
                    :key="m"
                    :value="m"
                  >
                    {{ m }}
                  </option>
                </select>
                <span class="text-sm text-theme-400">minutes</span>
              </div>

              <!-- Hourly -->
              <div
                v-else-if="dlgFrequency === 'hourly'"
                class="flex min-w-0 flex-wrap items-center gap-2"
              >
                <span class="text-sm text-theme-400">Every hour at minute</span>
                <select
                  v-model.number="dlgAtMinute"
                  class="px-3 py-1.5 bg-theme-900 border border-theme-700 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
                >
                  <option
                    v-for="m in MINUTE_OPTIONS"
                    :key="m"
                    :value="m"
                  >
                    :{{ String(m).padStart(2, "0") }}
                  </option>
                </select>
              </div>

              <!-- Daily -->
              <div
                v-else-if="dlgFrequency === 'daily'"
                class="flex min-w-0 flex-wrap items-center gap-2"
              >
                <span class="text-sm text-theme-400">Every day at</span>
                <select
                  v-model.number="dlgAtHour"
                  class="px-3 py-1.5 bg-theme-900 border border-theme-700 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
                >
                  <option
                    v-for="h in HOUR_OPTIONS"
                    :key="h"
                    :value="h"
                  >
                    {{ String(h).padStart(2, "0") }}
                  </option>
                </select>
                <span class="text-sm text-theme-400">:</span>
                <select
                  v-model.number="dlgAtMinute"
                  class="px-3 py-1.5 bg-theme-900 border border-theme-700 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
                >
                  <option
                    v-for="m in MINUTE_OPTIONS"
                    :key="m"
                    :value="m"
                  >
                    {{ String(m).padStart(2, "0") }}
                  </option>
                </select>
              </div>

              <!-- Weekly -->
              <div
                v-else-if="dlgFrequency === 'weekly'"
                class="flex min-w-0 flex-wrap items-center gap-2"
              >
                <span class="text-sm text-theme-400">Every</span>
                <select
                  v-model.number="dlgWeekday"
                  class="px-3 py-1.5 bg-theme-900 border border-theme-700 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
                >
                  <option
                    v-for="(label, i) in WEEKDAYS"
                    :key="i"
                    :value="i"
                  >
                    {{ label }}
                  </option>
                </select>
                <span class="text-sm text-theme-400">at</span>
                <select
                  v-model.number="dlgAtHour"
                  class="px-3 py-1.5 bg-theme-900 border border-theme-700 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
                >
                  <option
                    v-for="h in HOUR_OPTIONS"
                    :key="h"
                    :value="h"
                  >
                    {{ String(h).padStart(2, "0") }}
                  </option>
                </select>
                <span class="text-sm text-theme-400">:</span>
                <select
                  v-model.number="dlgAtMinute"
                  class="px-3 py-1.5 bg-theme-900 border border-theme-700 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
                >
                  <option
                    v-for="m in MINUTE_OPTIONS"
                    :key="m"
                    :value="m"
                  >
                    {{ String(m).padStart(2, "0") }}
                  </option>
                </select>
              </div>

              <!-- Monthly -->
              <div
                v-else-if="dlgFrequency === 'monthly'"
                class="flex min-w-0 flex-wrap items-center gap-2"
              >
                <span class="text-sm text-theme-400">On day</span>
                <select
                  v-model.number="dlgMonthDay"
                  class="px-3 py-1.5 bg-theme-900 border border-theme-700 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
                >
                  <option
                    v-for="d in 28"
                    :key="d"
                    :value="d"
                  >
                    {{ d }}
                  </option>
                </select>
                <span class="text-sm text-theme-400">at</span>
                <select
                  v-model.number="dlgAtHour"
                  class="px-3 py-1.5 bg-theme-900 border border-theme-700 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
                >
                  <option
                    v-for="h in HOUR_OPTIONS"
                    :key="h"
                    :value="h"
                  >
                    {{ String(h).padStart(2, "0") }}
                  </option>
                </select>
                <span class="text-sm text-theme-400">:</span>
                <select
                  v-model.number="dlgAtMinute"
                  class="px-3 py-1.5 bg-theme-900 border border-theme-700 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
                >
                  <option
                    v-for="m in MINUTE_OPTIONS"
                    :key="m"
                    :value="m"
                  >
                    {{ String(m).padStart(2, "0") }}
                  </option>
                </select>
              </div>

              <!-- Custom -->
              <div
                v-else-if="dlgFrequency === 'custom'"
                class="min-w-0 flex-1"
              >
                <input
                  v-model="dlgCustomExpr"
                  type="text"
                  placeholder="*/30 * * * *"
                  class="w-full px-3 py-1.5 bg-theme-900 border border-theme-700 rounded-lg text-sm text-theme-200 placeholder:text-theme-600 focus:outline-none focus:ring-1 focus:ring-accent-500 font-mono"
                >
                <p class="text-[11px] text-theme-600 mt-1">
                  Standard cron: minute hour day-of-month month day-of-week
                </p>
              </div>
            </div>

            <!-- Schedule summary -->
            <div class="flex items-center gap-2 px-3 py-2 rounded-lg bg-theme-900/70 border border-theme-700/50">
              <Icon
                icon="lucide:calendar-clock"
                class="w-3.5 h-3.5 text-sky-400 shrink-0"
              />
              <span class="text-xs text-theme-300">{{ dlgHumanReadable }}</span>
              <code class="ml-auto text-[11px] text-theme-600 font-mono">{{ dlgGeneratedExpr }}</code>
            </div>

            <!-- One-off -->
            <div class="mt-4 pt-4 border-t border-theme-700 flex items-start justify-between gap-4">
              <div class="flex-1">
                <div class="flex items-center gap-2 mb-1">
                  <Icon
                    icon="lucide:circle-play"
                    class="w-4 h-4 text-theme-400"
                  />
                  <h3 class="text-sm font-medium text-theme-200">
                    One-off
                  </h3>
                </div>
                <p class="text-xs text-theme-500 leading-relaxed">
                  When enabled, the job will automatically disable itself after the first successful run.
                </p>
              </div>
              <ToggleSwitch
                v-model="cronOneOff"
                label="Disable after first successful run"
                size="md"
                color="amber"
                class="mt-0.5"
              />
            </div>
          </BaseCard>

          <!-- Output Channel -->
          <BaseCard class="p-5">
            <div class="flex items-center gap-2 mb-1">
              <Icon
                icon="lucide:send"
                class="w-4 h-4 text-theme-400"
              />
              <h3 class="text-sm font-medium text-theme-200">
                Output Channel
              </h3>
              <span class="text-[10px] text-theme-600 font-mono ml-1">optional</span>
            </div>
            <p class="text-xs text-theme-500 leading-relaxed mb-4">
              Send the agent's result to a messaging channel after each run.
            </p>
            <select
              v-model="cronOutputChannelId"
              class="w-full bg-theme-900 border border-theme-700 text-theme-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500"
            >
              <option value="">
                None
              </option>
              <option
                v-for="ch in allChannels"
                :key="ch.id"
                :value="ch.id"
              >
                {{ ch.name }} ({{ ch.type }})
              </option>
            </select>
            <div
              v-if="cronOutputChannelId"
              class="mt-4 space-y-3"
            >
              <div>
                <label class="block text-xs text-theme-400 mb-1.5">Notify</label>
                <select
                  v-model="cronNotificationMode"
                  class="w-full bg-theme-900 border border-theme-700 text-theme-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500"
                >
                  <option value="always">
                    Always
                  </option>
                  <option value="conditional">
                    Conditional
                  </option>
                </select>
              </div>
              <div v-if="cronNotificationMode === 'conditional'">
                <label class="block text-xs text-theme-400 mb-1.5">Condition</label>
                <textarea
                  v-model="cronNotificationCondition"
                  placeholder="If the webpage mentions topic XY, which I'm interested in"
                  class="w-full bg-theme-900 border border-theme-700 text-theme-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500 resize-vertical"
                  rows="3"
                />
              </div>
            </div>
          </BaseCard>

          <!-- Cron Prompt -->
          <BaseCard class="p-5">
            <div class="flex items-center gap-2 mb-1">
              <Icon
                icon="lucide:file-clock"
                class="w-4 h-4 text-theme-400"
              />
              <h3 class="text-sm font-medium text-theme-200">
                Cron Prompt
              </h3>
            </div>
            <p class="text-xs text-theme-500 leading-relaxed mb-4">
              Describe what the agent should do on each cron trigger — API calls, file checks, data processing, etc.
            </p>
            <textarea
              ref="promptTextarea"
              v-model="cronPrompt"
              placeholder="Describe what the agent should do on each cron trigger…"
              class="w-full bg-theme-900 border border-theme-700 text-theme-100 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent-500 resize-vertical overflow-hidden"
              style="min-height: 5rem"
              @input="resizePrompt"
            />
          </BaseCard>
        </div>
      </template>
    </div>
  </div>
</template>
