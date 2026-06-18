<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { Icon } from "@iconify/vue";
import { api } from "../api/client";
import type { ActivityItem, ActivityKind } from "../api/types";
import { useChatStore } from "../stores/chat.store";
import { useAgentDefinitionsStore } from "../stores/agent-definitions.store";

const router = useRouter();
const chatStore = useChatStore();
const agentDefs = useAgentDefinitionsStore();

const items = ref<ActivityItem[]>([]);
const loading = ref(true);
const selectedKinds = ref<ActivityKind[]>(["instance", "artifact", "notification", "cron", "memory"]);
const searchQuery = ref("");
const now = ref(Date.now());
const stoppingInstanceIds = ref<Set<string>>(new Set());
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let unsubNotification: (() => void) | undefined;
let unsubExecutionUpdate: (() => void) | undefined;

const filterOptions: { value: ActivityKind; label: string; icon: string }[] = [
  { value: "instance", label: "Running", icon: "lucide:activity" },
  { value: "artifact", label: "Artifacts", icon: "lucide:file-output" },
  { value: "chat", label: "Chats", icon: "lucide:message-circle" },
  { value: "notification", label: "Notifications", icon: "lucide:bell" },
  { value: "cron", label: "Cron", icon: "lucide:clock" },
  { value: "memory", label: "Memory", icon: "lucide:brain" },
];

const filteredItems = computed(() => {
  const kinds = new Set(selectedKinds.value);
  const query = searchQuery.value.trim().toLowerCase();
  return items.value.filter((item) => {
    if (!kinds.has(item.kind)) return false;
    if (!query) return true;
    return activitySearchText(item).includes(query);
  });
});

const totalByKind = computed(() => {
  const totals: Record<ActivityKind, number> = {
    instance: 0,
    artifact: 0,
    notification: 0,
    cron: 0,
    memory: 0,
    chat: 0,
  };
  for (const item of items.value) totals[item.kind] += 1;
  return totals;
});

const allKindsSelected = computed(() => selectedKinds.value.length === filterOptions.length);

function toggleKind(kind: ActivityKind): void {
  selectedKinds.value = selectedKinds.value.includes(kind)
    ? selectedKinds.value.filter((selected) => selected !== kind)
    : [...selectedKinds.value, kind];
}

function toggleAllKinds(): void {
  selectedKinds.value = allKindsSelected.value
    ? []
    : filterOptions.map((option) => option.value);
}

function activitySearchText(item: ActivityItem): string {
  return [
    item.kind,
    item.title,
    item.description,
    item.agentName,
    item.agentId,
    item.status,
    item.severity,
    item.sourceLabel,
    item.sourceId,
    ...(item.artifacts?.flatMap((artifact) => [
      artifact.label,
      artifact.ext,
      artifact.kind,
    ]) || []),
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
}

function clearSearch(): void {
  searchQuery.value = "";
}

async function loadActivity() {
  try {
    items.value = await api.activity.list({ limit: 120 });
  } finally {
    loading.value = false;
  }
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

function formatDateLabel(ts: number): string {
  const date = new Date(ts);
  const today = new Date(now.value);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
  });
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

const groupedItems = computed(() => {
  const groups: { label: string; items: ActivityItem[] }[] = [];
  for (const item of filteredItems.value) {
    const label = formatDateLabel(item.createdAt);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
});

function kindIcon(kind: ActivityKind): string {
  switch (kind) {
    case "artifact":
      return "lucide:file-output";
    case "notification":
      return "lucide:bell";
    case "cron":
      return "lucide:clock-check";
    case "memory":
      return "lucide:brain";
    case "chat":
      return "lucide:message-circle";
    default:
      return "lucide:activity";
  }
}

function kindClass(item: ActivityItem): string {
  if (item.kind === "instance") return "activity-instance";
  if (item.kind === "notification") return "activity-notification";
  if (item.kind === "artifact") return "activity-artifact";
  if (item.kind === "cron") return "activity-cron";
  if (item.kind === "memory") return "activity-memory";
  if (item.kind === "chat") return "activity-chat";
  return "activity-info";
}

function agentLabel(item: ActivityItem): string {
  if (item.agentName) return item.agentName;
  if (item.agentId) return agentDefs.get(item.agentId)?.name || "Agent";
  return item.kind === "memory" ? "Memory" : "System";
}

async function openItem(item: ActivityItem) {
  if (item.conversationId) {
    await chatStore.setActiveAgent(item.agentId || null);
    await chatStore.selectConversation(item.conversationId);
    router.push("/triggers/chat");
  } else if (item.agentId) {
    router.push(`/agents/${item.agentId}`);
  }
}

function canStopItem(item: ActivityItem): boolean {
  return item.kind === "instance" && Boolean(item.sourceId);
}

function artifactIcon(kind: string): string {
  if (kind === "image") return "lucide:image";
  if (kind === "video") return "lucide:film";
  return "lucide:file";
}

function isImageArtifact(kind: string): boolean {
  return kind === "image";
}

async function stopInstance(item: ActivityItem, event: Event) {
  event.stopPropagation();
  if (!item.sourceId || stoppingInstanceIds.value.has(item.sourceId)) return;

  stoppingInstanceIds.value.add(item.sourceId);
  try {
    await api.instances.stop(item.sourceId);
    await loadActivity();
  } catch {
    await loadActivity();
  } finally {
    stoppingInstanceIds.value.delete(item.sourceId);
  }
}

onMounted(() => {
  void loadActivity();
  refreshTimer = setInterval(() => void loadActivity(), 15_000);
  tickTimer = setInterval(() => {
    now.value = Date.now();
  }, 30_000);
  unsubNotification = api.notifications.onCreated(() => void loadActivity());
  unsubExecutionUpdate = api.agent.onExecutionUpdate((data: unknown) => {
    const d = data as { event?: string };
    if (d.event === "step:status" || d.event === "task:completed" || d.event === "step:executed") {
      void loadActivity();
    }
  });
});

onUnmounted(() => {
  clearInterval(refreshTimer);
  clearInterval(tickTimer);
  unsubNotification?.();
  unsubExecutionUpdate?.();
});
</script>

<template>
  <div class="h-full overflow-y-auto px-4 py-4 pb-12 sm:px-8 sm:py-6">
    <header class="mb-4 mx-auto flex max-w-6xl flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 class="text-[1.45rem] font-bold tracking-[0.02em] text-theme-100">
          Activity Log
        </h1>
        <p class="mt-1 max-w-3xl text-sm text-theme-500">
          Running instances, generated artifacts, chats, notifications, cron runs, and memory indexing in one timeline.
        </p>
      </div>
      <button
        class="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-theme-800 bg-theme-900/80 px-3 py-2 text-[13px] text-theme-400 transition hover:border-theme-700 hover:bg-theme-800 hover:text-theme-100 disabled:cursor-wait disabled:opacity-70 sm:w-auto"
        :disabled="loading"
        @click="loadActivity"
      >
        <Icon
          icon="lucide:refresh-cw"
          class="w-4 h-4"
          :class="{ 'animate-spin': loading }"
        />
        Refresh
      </button>
    </header>

    <div class="mb-3 mx-auto max-w-6xl">
      <div class="relative">
        <Icon
          icon="lucide:search"
          class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-600"
        />
        <input
          v-model="searchQuery"
          type="search"
          class="w-full rounded-lg border border-theme-800 bg-theme-900/80 py-2 pl-9 pr-10 text-[13px] text-theme-100 outline-none transition placeholder:text-theme-600 focus:border-accent-500/60 focus:bg-theme-900"
          placeholder="Search activity..."
        >
        <button
          v-if="searchQuery"
          class="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-theme-500 transition hover:bg-theme-800 hover:text-theme-200"
          title="Clear search"
          @click="clearSearch"
        >
          <Icon
            icon="lucide:x"
            class="h-3.5 w-3.5"
          />
        </button>
      </div>
    </div>

    <div class="mb-5 flex max-w-6xl flex-wrap gap-2 mx-auto">
      <button
        class="filter-chip inline-flex items-center gap-2 rounded-lg border border-theme-800 bg-theme-900/80 px-3 py-2 text-[13px] text-theme-400 transition hover:border-theme-700 hover:bg-theme-800 hover:text-theme-100"
        :class="{ 'filter-chip-active': allKindsSelected }"
        @click="toggleAllKinds"
      >
        <span class="h-1.5 w-1.5 rounded-full bg-current opacity-85" />
        <Icon
          icon="lucide:list-filter"
          class="w-3.5 h-3.5"
        />
        <span>All</span>
        <span class="rounded-full bg-theme-700/55 px-1.5 py-0.5 text-[11px] tabular-nums text-theme-300">{{ items.length }}</span>
      </button>
      <button
        v-for="option in filterOptions"
        :key="option.value"
        class="filter-chip inline-flex items-center gap-2 rounded-lg border border-theme-800 bg-theme-900/80 px-3 py-2 text-[13px] text-theme-400 transition hover:border-theme-700 hover:bg-theme-800 hover:text-theme-100"
        :class="{ 'filter-chip-active': selectedKinds.includes(option.value) }"
        @click="toggleKind(option.value)"
      >
        <span class="h-1.5 w-1.5 rounded-full bg-current opacity-85" />
        <Icon
          :icon="option.icon"
          class="w-3.5 h-3.5"
        />
        <span>{{ option.label }}</span>
        <span class="rounded-full bg-theme-700/55 px-1.5 py-0.5 text-[11px] tabular-nums text-theme-300">{{ totalByKind[option.value] }}</span>
      </button>
    </div>

    <div
      v-if="loading && items.length === 0"
      class="flex min-h-80 flex-col items-center justify-center gap-3 text-sm text-theme-500"
    >
      <Icon
        icon="lucide:loader-2"
        class="w-8 h-8 animate-spin text-theme-500"
      />
      <p>Loading activity...</p>
    </div>

    <div
      v-else-if="filteredItems.length === 0"
      class="flex min-h-80 flex-col items-center justify-center gap-3 text-sm text-theme-500"
    >
      <Icon
        icon="lucide:inbox"
        class="w-9 h-9 text-theme-600"
      />
      <p>{{ searchQuery.trim() ? "No activity matches your search." : "No activity for this filter yet." }}</p>
    </div>

    <div
      v-else
      class="mx-auto max-w-6xl "
    >
      <section
        v-for="group in groupedItems"
        :key="group.label"
        class="mb-6"
      >
        <div class="sticky -top-6 z-[5]   flex items-center gap-3 bg-theme-900 py-4 text-[11px] font-bold uppercase tracking-[0.065em] text-theme-500">
          <span class="text-lg">{{ group.label }}</span>
          <span class="font-semibold text-theme-600">{{ group.items.length }} events</span>
        </div>

        <div class="flex flex-col gap-2">
          <article
            v-for="item in group.items"
            :key="item.id"
            class="grid grid-cols-[2rem_minmax(0,1fr)] items-stretch gap-3 sm:grid-cols-[4.2rem_2rem_minmax(0,1fr)]"
            :class="[kindClass(item), { 'cursor-pointer': item.conversationId || item.agentId }]"
            @click="openItem(item)"
          >
            <div class="hidden pt-3.5 text-right text-xs tabular-nums text-theme-500 sm:block">
              <span>{{ formatClock(item.createdAt) }}</span>
              <small class="mt-0.5 block text-[10px] text-theme-700">{{ formatTimeAgo(item.createdAt) }}</small>
            </div>

            <div class="mt-2.5 flex h-8 w-8 items-center justify-center rounded-full border text-[var(--activity-color)] activity-marker">
              <Icon
                :icon="kindIcon(item.kind)"
                class="w-4 h-4"
              />
            </div>

            <div class="activity-card min-w-0 rounded-xl border border-theme-800 bg-theme-950 px-4 py-3 transition">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] text-theme-600">
                    <span class="font-bold uppercase tracking-[0.055em] text-[var(--activity-color)]">
                      {{ item.kind }}
                    </span>
                    <span v-if="item.sourceLabel">
                      {{ item.sourceLabel }}
                    </span>
                  </div>

                  <h2 class="text-[15px] font-bold leading-snug text-theme-100">
                    {{ item.title }}
                  </h2>
                </div>

                <div class="flex gap-2">
                  <span
                    v-if="item.status"
                    class="status-pill shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold lowercase"
                  >
                    {{ item.status }}
                  </span>

                  <button
                    v-if="canStopItem(item)"
                    class="inline-flex shrink-0 items-center gap-1 rounded-full border border-red-400/25 bg-red-400/10 px-2 py-0.5 text-[11px] font-bold text-red-400 transition hover:border-red-300/40 hover:bg-red-400/15 hover:text-red-200 disabled:cursor-wait disabled:opacity-70"
                    :disabled="stoppingInstanceIds.has(item.sourceId!)"
                    title="Stop instance"
                    @click="stopInstance(item, $event)"
                  >
                    <Icon
                      :icon="stoppingInstanceIds.has(item.sourceId!) ? 'lucide:loader-2' : 'lucide:square'"
                      class="w-3 h-3"
                      :class="{ 'animate-spin': stoppingInstanceIds.has(item.sourceId!) }"
                    />
                    Stop
                  </button>
                </div>
              </div>

              <p
                v-if="item.description"
                class="mt-1.5 text-[13px] leading-relaxed text-theme-400"
              >
                {{ item.description }}
              </p>

              <div
                v-if="item.artifacts?.length"
                class="mt-3 flex flex-wrap gap-2"
              >
                <a
                  v-for="artifact in item.artifacts"
                  :key="artifact.href"
                  :href="artifact.href"
                  target="_blank"
                  rel="noreferrer"
                  class="artifact-link inline-flex max-w-72 items-center gap-2 overflow-hidden rounded-md border px-2 py-1.5 text-xs text-theme-200"
                  :class="{ 'min-h-16 pr-3': isImageArtifact(artifact.kind) }"
                  @click.stop
                >
                  <img
                    v-if="isImageArtifact(artifact.kind)"
                    :src="artifact.href"
                    :alt="artifact.label"
                    loading="lazy"
                    class="h-12 w-16 shrink-0 rounded object-cover"
                  >
                  <Icon
                    v-else
                    :icon="artifactIcon(artifact.kind)"
                    class="h-3.5 w-3.5 shrink-0"
                  />
                  <span class="min-w-0 truncate">{{ artifact.label }}</span>
                  <span class="shrink-0 text-[10px] uppercase text-theme-500">{{ artifact.ext }}</span>
                </a>
              </div>

              <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-theme-500">
                <span class="inline-flex items-center gap-1">
                  <Icon
                    icon="lucide:user-round"
                    class="w-3 h-3"
                  />
                  {{ agentLabel(item) }}
                </span>

                <span
                  v-if="item.conversationId || item.agentId"
                  class="inline-flex items-center gap-1"
                >
                  <Icon
                    icon="lucide:external-link"
                    class="w-3 h-3"
                  />
                  Open
                </span>
              </div>
            </div>
          </article>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.filter-chip-active {
  color: var(--color-accent-300);
  border-color: color-mix(in srgb, var(--color-accent-500) 50%, transparent);
  background: color-mix(in srgb, var(--color-accent-500) 13%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-accent-500) 12%, transparent) inset;
}

.activity-marker {
  background: var(--activity-bg);
  border: 1px solid var(--activity-border);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--activity-color) 5%, transparent);
}

.activity-card {
  border-left: 3px solid var(--activity-color);
}

article.cursor-pointer:hover .activity-card {
  transform: translateX(2px);
  border-color: color-mix(in srgb, var(--activity-color) 35%, var(--color-theme-800));
  background:
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--activity-color) 10%, transparent),
      transparent 36%
    ),
    var(--color-theme-900);
}

.status-pill {
  color: var(--activity-color);
  background: color-mix(in srgb, var(--activity-color) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--activity-color) 28%, transparent);
}

.artifact-link {
  background: color-mix(in srgb, var(--activity-color) 9%, var(--color-theme-850, var(--color-theme-800)));
  border: 1px solid color-mix(in srgb, var(--activity-color) 18%, transparent);
}

.activity-info,
.activity-instance,
.activity-artifact,
.activity-notification,
.activity-cron,
.activity-chat,
.activity-memory,
.activity-warning,
.activity-critical {
  --activity-color: var(--color-accent-400);
  --activity-bg: color-mix(in srgb, var(--color-accent-500) 12%, var(--color-theme-950));
  --activity-border: color-mix(in srgb, var(--color-accent-500) 35%, var(--color-theme-800));
}

.activity-cron {
  --activity-color: #38bdf8;
  --activity-bg: color-mix(in srgb, #38bdf8 12%, var(--color-theme-950));
  --activity-border: color-mix(in srgb, #38bdf8 35%, var(--color-theme-800));
}

.activity-instance {
  --activity-color: #f87171;
  --activity-bg: color-mix(in srgb, #f87171 12%, var(--color-theme-950));
  --activity-border: color-mix(in srgb, #f87171 38%, var(--color-theme-800));
}

.activity-artifact {
  --activity-color: #22c55e;
  --activity-bg: color-mix(in srgb, #22c55e 12%, var(--color-theme-950));
  --activity-border: color-mix(in srgb, #22c55e 35%, var(--color-theme-800));
}

.activity-notification {
  --activity-color: #f59e0b;
  --activity-bg: color-mix(in srgb, #f59e0b 12%, var(--color-theme-950));
  --activity-border: color-mix(in srgb, #f59e0b 38%, var(--color-theme-800));
}

.activity-memory {
  --activity-color: #a78bfa;
  --activity-bg: color-mix(in srgb, #a78bfa 12%, var(--color-theme-950));
  --activity-border: color-mix(in srgb, #a78bfa 35%, var(--color-theme-800));
}

.activity-chat {
  --activity-color: #60a5fa;
  --activity-bg: color-mix(in srgb, #60a5fa 12%, var(--color-theme-950));
  --activity-border: color-mix(in srgb, #60a5fa 35%, var(--color-theme-800));
}
</style>
