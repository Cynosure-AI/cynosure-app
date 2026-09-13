<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { Icon } from "@iconify/vue";
import { api } from "../api/client";
import type { AgentInstance, MemoryIndexJob } from "../api/types";
import { useChatStore } from "../stores/chat.store";
import { useMemoryJobsStore } from "../stores/memory-jobs.store";

const router = useRouter();
const chatStore = useChatStore();
const memoryJobsStore = useMemoryJobsStore();

const instances = ref<AgentInstance[]>([]);
const loading = ref(true);
const refreshing = ref(false);
const stoppingIds = ref<Set<string>>(new Set());
const cancellingJobIds = ref<Set<string>>(new Set());
const now = ref(Date.now());

let pollTimer: ReturnType<typeof setInterval> | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let unsubHITLRequest: (() => void) | undefined;
let unsubExecutionUpdate: (() => void) | undefined;
let unsubChatExecutionState: (() => void) | undefined;
let unsubMemoryJobUpdate: (() => void) | undefined;
let dataLoadRevision = 0;

type WorkEntry =
  | { kind: "instance"; id: string; instance: AgentInstance; startedAt: number; requiresAttention: boolean }
  | MemoryEntry;

type MemoryEntry = { kind: "memory"; id: string; job: MemoryIndexJob; startedAt: number; requiresAttention: false };

const runningEntries = computed<WorkEntry[]>(() => {
  const entries: WorkEntry[] = [
    ...instances.value.map((instance) => ({
      kind: "instance" as const,
      id: instance.id,
      instance,
      startedAt: instance.startedAt,
      requiresAttention: instance.status === "awaiting-approval",
    })),
    ...memoryJobsStore.runningJobs.map((job) => ({
      kind: "memory" as const,
      id: `memory-${job.id}`,
      job,
      startedAt: job.createdAt,
      requiresAttention: false as const,
    })),
  ];

  return entries.sort((a, b) => {
    if (a.requiresAttention !== b.requiresAttention) return a.requiresAttention ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === "instance" ? -1 : 1;
    return b.startedAt - a.startedAt;
  });
});

const runningCount = computed(() => runningEntries.value.length);
const queuedEntries = computed<MemoryEntry[]>(() =>
  memoryJobsStore.jobs
    .filter((job) => job.status === "queued")
    .map((job) => ({
      kind: "memory" as const,
      id: `memory-${job.id}`,
      job,
      startedAt: job.createdAt,
      requiresAttention: false as const,
    }))
    .sort((a, b) => a.startedAt - b.startedAt),
);
const queuedCount = computed(() => queuedEntries.value.length);

async function loadData(): Promise<void> {
  const revision = ++dataLoadRevision;
  try {
    refreshing.value = true;
    const [active] = await Promise.all([
      api.instances.list(),
      memoryJobsStore.refresh(),
    ]);
    if (revision === dataLoadRevision) instances.value = active;
  } finally {
    if (revision === dataLoadRevision) {
      loading.value = false;
      refreshing.value = false;
    }
  }
}

async function openConversation(conversationId: string | null, agentId: string | null): Promise<void> {
  if (!conversationId) {
    router.push(agentId ? `/agents/${agentId}` : "/chat");
    return;
  }
  await chatStore.setActiveAgent(agentId || null);
  await chatStore.selectConversation(conversationId);
  router.push(`/chat/${encodeURIComponent(conversationId)}`);
}

async function openInstance(instance: AgentInstance): Promise<void> {
  await openConversation(instance.conversationId, instance.agentId || null);
}

async function stopInstance(instance: AgentInstance, event?: Event): Promise<void> {
  event?.stopPropagation();
  if (stoppingIds.value.has(instance.id)) return;

  stoppingIds.value.add(instance.id);
  try {
    await api.instances.stop(instance.id);
    await loadData();
  } catch {
    await loadData();
  } finally {
    stoppingIds.value.delete(instance.id);
  }
}

async function cancelMemoryJob(job: MemoryIndexJob, event?: Event): Promise<void> {
  event?.stopPropagation();
  if (cancellingJobIds.value.has(job.id)) return;

  cancellingJobIds.value.add(job.id);
  try {
    await memoryJobsStore.cancelJob(job.id);
  } finally {
    cancellingJobIds.value.delete(job.id);
  }
}

function openMemoryJobs(): void {
  router.push("/memory-categories/documents");
}

function formatTimeAgo(ts: number): string {
  const mins = Math.floor(Math.max(0, now.value - ts) / 60_000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  if (days > 0) return `${days}d ago`;
  if (hrs > 0) return `${hrs}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "Just now";
}

function instanceTypeLabel(type: AgentInstance["type"]): string {
  if (type === "multi-agent") return "Multi-agent";
  if (type === "cron") return "Cron";
  if (type === "channel") return "Channel";
  return "Chat";
}

function typeIcon(type: string): string {
  if (type === "cron") return "lucide:clock-check";
  if (type === "channel" || type === "channels") return "lucide:radio";
  if (type === "multi-agent") return "lucide:workflow";
  return "lucide:message-circle";
}

function instanceTypeClass(type: AgentInstance["type"]): string {
  if (type === "cron") return "border-cyan-400/30 bg-cyan-400/10 text-cyan-300";
  return "border-theme-700 bg-theme-900 text-theme-400";
}

function memoryJobTitle(job: MemoryIndexJob): string {
  const progress = job.kind === "deep-research" && job.progressCurrent && job.progressTotal
    ? ` (batch ${job.progressCurrent}/${job.progressTotal})`
    : "";
  const action = job.kind === "deep-research" ? `Running Deep Research${progress} from` : "Indexing";
  return `${action} ${job.fileName}`;
}

function memoryJobLabel(job: MemoryIndexJob): string {
  return job.kind === "deep-research" ? "Deep Research" : "Memory indexing";
}

function memoryJobIcon(job: MemoryIndexJob): string {
  return job.kind === "deep-research" ? "lucide:network" : "lucide:database-zap";
}

function entryRowClass(entry: WorkEntry): string {
  if (entry.requiresAttention) return "instance-attention";
  if (entry.kind === "memory") return "instance-memory";
  if (entry.instance.type === "cron") return "instance-cron";
  return "";
}

function iconShellClass(entry: WorkEntry): string {
  if (entry.kind === "memory") return "border-purple-400/25 bg-purple-400/10 text-purple-300";
  if (entry.instance.type === "cron") return "border-cyan-400/25 bg-cyan-400/10 text-cyan-300";
  return "border-theme-700 bg-theme-800 text-accent-300";
}

function entryKindClass(entry: WorkEntry): string {
  if (entry.kind === "memory") return "border-purple-400/25 bg-purple-400/10 text-purple-300";
  return instanceTypeClass(entry.instance.type);
}

function entryStatusClass(entry: WorkEntry): string {
  if (entry.kind === "instance" && entry.instance.status === "awaiting-approval") {
    return "border border-amber-400/35 bg-amber-400/10 text-amber-300";
  }
  if (entry.kind === "memory") return "border border-purple-400/30 bg-purple-400/10 text-purple-300";
  if (entry.kind === "instance" && entry.instance.type === "cron") {
    return "border border-cyan-400/30 bg-cyan-400/10 text-cyan-300";
  }
  return "border border-accent-400/30 bg-accent-400/10 text-accent-300";
}

function statusText(entry: WorkEntry): string {
  if (entry.kind === "instance") return entry.instance.status;
  if (entry.job.status === "queued") return "Queued";
  if (entry.job.status === "retrying") return `Retrying (${entry.job.attempt}/${entry.job.maxAttempts})`;
  return entry.job.status;
}

onMounted(() => {
  void loadData();
  pollTimer = setInterval(() => void loadData(), 5_000);
  tickTimer = setInterval(() => {
    now.value = Date.now();
  }, 30_000);
  unsubHITLRequest = api.agent.onHITLRequest(() => void loadData());
  unsubExecutionUpdate = api.agent.onExecutionUpdate((data: unknown) => {
    const payload = data as { event?: string };
    if (payload.event === "step:status" || payload.event === "task:completed" || payload.event === "step:executed") {
      void loadData();
    }
  });
  unsubChatExecutionState = api.chat.onExecutionState(() => {
    void loadData();
  });
  unsubMemoryJobUpdate = api.memoryCategories.onJobUpdated((job) => {
    memoryJobsStore.upsertJob(job);
  });
});

onUnmounted(() => {
  clearInterval(pollTimer);
  clearInterval(tickTimer);
  unsubHITLRequest?.();
  unsubExecutionUpdate?.();
  unsubChatExecutionState?.();
  unsubMemoryJobUpdate?.();
});
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="mx-auto max-w-6xl px-6 py-8">
      <header class="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 class="text-2xl font-bold text-theme-100">
            Instances
          </h1>
          <p class="mt-1 text-sm text-theme-500">
            Running conversations and background jobs
          </p>
        </div>
        <button
          class="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-theme-800 bg-theme-900/80 px-3 py-2 text-[13px] text-theme-400 transition hover:border-theme-700 hover:bg-theme-800 hover:text-theme-100 disabled:cursor-wait disabled:opacity-70 sm:w-auto"
          :disabled="refreshing"
          @click="loadData"
        >
          <Icon
            icon="lucide:refresh-cw"
            class="h-4 w-4"
            :class="{ 'animate-spin': refreshing }"
          />
          Refresh
        </button>
      </header>

      <section>
        <div class="mb-3 flex items-center justify-between gap-3">
          <h2 class="text-lg font-bold text-theme-100">
            Running Now
          </h2>
          <span class="text-xs text-theme-600">{{ runningCount }} active</span>
        </div>

        <div
          v-if="loading && !runningEntries.length"
          class="flex min-h-44 flex-col items-center justify-center gap-3 rounded-lg border border-theme-800 bg-theme-900 text-sm text-theme-500"
        >
          <Icon
            icon="lucide:loader-2"
            class="h-7 w-7 animate-spin"
          />
          Loading instances...
        </div>

        <div
          v-else-if="!runningEntries.length"
          class="flex min-h-44 flex-col items-center justify-center gap-3 rounded-lg border border-theme-800 bg-theme-900 text-sm text-theme-500"
        >
          <Icon
            icon="lucide:circle-check"
            class="h-8 w-8 text-theme-600"
          />
          No running conversations or background jobs.
        </div>

        <div
          v-else
          class="grid gap-2"
        >
          <article
            v-for="entry in runningEntries"
            :key="entry.id"
            class="instance-row rounded-lg border border-theme-800 bg-theme-900 px-4 py-3 transition hover:border-accent-500/40 hover:bg-theme-850"
            :class="['cursor-pointer', entryRowClass(entry)]"
            @click="entry.kind === 'instance' ? openInstance(entry.instance) : openMemoryJobs()"
          >
            <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div class="flex min-w-0 items-start gap-3">
                <div
                  class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border"
                  :class="iconShellClass(entry)"
                >
                  <img
                    v-if="entry.kind === 'instance' && entry.instance.agentIconUrl"
                    :src="entry.instance.agentIconUrl"
                    :alt="entry.instance.agentName"
                    class="h-full w-full rounded-lg object-cover"
                    :class="{ 'opacity-70': entry.instance.status === 'awaiting-approval' }"
                  >
                  <Icon
                    v-else
                    :icon="entry.kind === 'instance'
                      ? (entry.instance.status === 'awaiting-approval' ? 'lucide:circle-alert' : typeIcon(entry.instance.type))
                      : memoryJobIcon(entry.job)"
                    class="h-4.5 w-4.5"
                    :class="{
                      'animate-pulse text-amber-300': entry.kind === 'instance' && entry.instance.status === 'awaiting-approval',
                      'text-cyan-300': entry.kind === 'instance' && entry.instance.type === 'cron' && entry.instance.status !== 'awaiting-approval',
                      'animate-pulse text-purple-300': entry.kind === 'memory',
                    }"
                  />
                </div>
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <h3 class="truncate text-[15px] font-bold text-theme-100">
                      {{ entry.kind === 'instance' ? entry.instance.agentName : memoryJobTitle(entry.job) }}
                    </h3>
                    <span
                      class="rounded-full border px-2 py-0.5 text-[11px]"
                      :class="entryKindClass(entry)"
                    >
                      {{ entry.kind === 'instance' ? instanceTypeLabel(entry.instance.type) : memoryJobLabel(entry.job) }}
                    </span>
                    <span
                      class="rounded-full px-2 py-0.5 text-[11px] font-bold lowercase"
                      :class="entryStatusClass(entry)"
                    >
                      {{ statusText(entry) }}
                    </span>
                  </div>
                  <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-theme-500">
                    <span>{{ entry.kind === 'instance' ? (entry.instance.model || "Model unknown") : entry.job.fileName }}</span>
                    <span>{{ formatTimeAgo(entry.startedAt) }}</span>
                  </div>
                </div>
              </div>

              <div class="flex shrink-0 gap-2">
                <button
                  class="inline-flex items-center gap-2 rounded-lg border border-theme-700 bg-theme-900 px-3 py-1.5 text-xs font-medium text-theme-300 transition hover:border-theme-600 hover:bg-theme-800 hover:text-theme-100"
                  @click.stop="entry.kind === 'instance' ? openInstance(entry.instance) : openMemoryJobs()"
                >
                  <Icon
                    icon="lucide:external-link"
                    class="h-3.5 w-3.5"
                  />
                  Open
                </button>
                <button
                  class="inline-flex items-center gap-2 rounded-lg border border-red-400/25 bg-red-400/10 px-3 py-1.5 text-xs font-medium text-red-300 transition hover:border-red-300/40 hover:bg-red-400/15 hover:text-red-200 disabled:cursor-wait disabled:opacity-70"
                  :disabled="entry.kind === 'instance' ? stoppingIds.has(entry.instance.id) : cancellingJobIds.has(entry.job.id)"
                  @click="entry.kind === 'instance' ? stopInstance(entry.instance, $event) : cancelMemoryJob(entry.job, $event)"
                >
                  <Icon
                    :icon="(entry.kind === 'instance' ? stoppingIds.has(entry.instance.id) : cancellingJobIds.has(entry.job.id)) ? 'lucide:loader-2' : (entry.kind === 'instance' ? 'lucide:square' : 'lucide:x')"
                    class="h-3.5 w-3.5"
                    :class="{ 'animate-spin': entry.kind === 'instance' ? stoppingIds.has(entry.instance.id) : cancellingJobIds.has(entry.job.id) }"
                  />
                  {{ entry.kind === 'instance' ? 'Stop' : 'Cancel' }}
                </button>
              </div>
            </div>
          </article>
        </div>
      </section>

      <section
        v-if="queuedEntries.length > 0"
        class="mt-8"
      >
        <div class="mb-3 flex items-center justify-between gap-3">
          <h2 class="text-lg font-bold text-theme-100">
            Queued
          </h2>
          <span class="text-xs text-theme-600">{{ queuedCount }} waiting</span>
        </div>

        <div class="grid gap-2">
          <article
            v-for="entry in queuedEntries"
            :key="entry.id"
            class="instance-row instance-memory cursor-pointer rounded-lg border border-theme-800 bg-theme-900 px-4 py-3 transition hover:border-purple-400/40 hover:bg-theme-850"
            @click="openMemoryJobs()"
          >
            <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div class="flex min-w-0 items-start gap-3">
                <div
                  class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border"
                  :class="iconShellClass(entry)"
                >
                  <Icon
                    :icon="memoryJobIcon(entry.job)"
                    class="h-4.5 w-4.5 text-purple-300"
                  />
                </div>
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <h3 class="truncate text-[15px] font-bold text-theme-100">
                      {{ memoryJobTitle(entry.job) }}
                    </h3>
                    <span
                      class="rounded-full border px-2 py-0.5 text-[11px]"
                      :class="entryKindClass(entry)"
                    >
                      {{ memoryJobLabel(entry.job) }}
                    </span>
                    <span
                      class="rounded-full px-2 py-0.5 text-[11px] font-bold lowercase"
                      :class="entryStatusClass(entry)"
                    >
                      {{ statusText(entry) }}
                    </span>
                  </div>
                  <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-theme-500">
                    <span>{{ entry.job.fileName }}</span>
                    <span>{{ formatTimeAgo(entry.startedAt) }}</span>
                  </div>
                </div>
              </div>

              <div class="flex shrink-0 gap-2">
                <button
                  class="inline-flex items-center gap-2 rounded-lg border border-theme-700 bg-theme-900 px-3 py-1.5 text-xs font-medium text-theme-300 transition hover:border-theme-600 hover:bg-theme-800 hover:text-theme-100"
                  @click.stop="openMemoryJobs()"
                >
                  <Icon
                    icon="lucide:external-link"
                    class="h-3.5 w-3.5"
                  />
                  Open
                </button>
                <button
                  class="inline-flex items-center gap-2 rounded-lg border border-red-400/25 bg-red-400/10 px-3 py-1.5 text-xs font-medium text-red-300 transition hover:border-red-300/40 hover:bg-red-400/15 hover:text-red-200 disabled:cursor-wait disabled:opacity-70"
                  :disabled="cancellingJobIds.has(entry.job.id)"
                  @click="cancelMemoryJob(entry.job, $event)"
                >
                  <Icon
                    :icon="cancellingJobIds.has(entry.job.id) ? 'lucide:loader-2' : 'lucide:x'"
                    class="h-3.5 w-3.5"
                    :class="{ 'animate-spin': cancellingJobIds.has(entry.job.id) }"
                  />
                  Cancel
                </button>
              </div>
            </div>
          </article>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.instance-memory {
  border-color: color-mix(in srgb, #c084fc 22%, var(--color-theme-800));
}

.instance-memory:hover {
  border-color: color-mix(in srgb, #c084fc 44%, var(--color-theme-800));
}

.instance-cron {
  border-color: color-mix(in srgb, #22d3ee 20%, var(--color-theme-800));
}

.instance-cron:hover {
  border-color: color-mix(in srgb, #22d3ee 42%, var(--color-theme-800));
}

.instance-attention {
  border-color: color-mix(in srgb, #fbbf24 32%, var(--color-theme-800));
  background:
    linear-gradient(90deg, color-mix(in srgb, #fbbf24 10%, transparent), transparent 42%),
    var(--color-theme-900);
}
</style>
