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
const selectedKind = ref<ActivityKind | "all">("all");
const now = ref(Date.now());
const stoppingInstanceIds = ref<Set<string>>(new Set());
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let unsubNotification: (() => void) | undefined;
let unsubExecutionUpdate: (() => void) | undefined;

const filterOptions: { value: ActivityKind | "all"; label: string; icon: string }[] = [
  { value: "all", label: "All", icon: "lucide:list-filter" },
  { value: "instance", label: "Running", icon: "lucide:activity" },
  { value: "artifact", label: "Artifacts", icon: "lucide:file-output" },
  { value: "notification", label: "Notifications", icon: "lucide:bell" },
  { value: "cron", label: "Cron", icon: "lucide:clock" },
  { value: "memory", label: "Memory", icon: "lucide:brain" },
];

const filteredItems = computed(() => {
  if (selectedKind.value === "all") return items.value;
  return items.value.filter((item) => item.kind === selectedKind.value);
});

const totalByKind = computed(() => {
  const totals: Record<ActivityKind | "all", number> = {
    all: items.value.length,
    instance: 0,
    artifact: 0,
    notification: 0,
    cron: 0,
    memory: 0,
  };
  for (const item of items.value) totals[item.kind] += 1;
  return totals;
});

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
  <div class="activity-view">
    <header class="activity-header">
      <div>
        <h1 class="activity-title">
          Activity Log
        </h1>
        <p class="activity-subtitle">
          Running instances, generated artifacts, notifications, cron runs, and memory indexing in one timeline.
        </p>
      </div>
      <button
        class="refresh-button"
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

    <div class="filter-row">
      <button
        v-for="option in filterOptions"
        :key="option.value"
        class="filter-chip"
        :class="{ active: selectedKind === option.value }"
        @click="selectedKind = option.value"
      >
        <Icon
          :icon="option.icon"
          class="w-3.5 h-3.5"
        />
        <span>{{ option.label }}</span>
        <span class="filter-count">{{ totalByKind[option.value] }}</span>
      </button>
    </div>

    <div
      v-if="loading && items.length === 0"
      class="empty-state"
    >
      <Icon
        icon="lucide:loader-2"
        class="w-8 h-8 animate-spin text-theme-500"
      />
      <p>Loading activity...</p>
    </div>

    <div
      v-else-if="filteredItems.length === 0"
      class="empty-state"
    >
      <Icon
        icon="lucide:inbox"
        class="w-9 h-9 text-theme-600"
      />
      <p>No activity for this filter yet.</p>
    </div>

    <div
      v-else
      class="activity-feed"
    >
      <section
        v-for="group in groupedItems"
        :key="group.label"
        class="feed-group"
      >
        <div class="feed-group-header">
          <span>{{ group.label }}</span>
          <span>{{ group.items.length }} events</span>
        </div>

        <div class="feed-list">
          <article
            v-for="item in group.items"
            :key="item.id"
            class="feed-item"
            :class="[kindClass(item), { clickable: item.conversationId || item.agentId }]"
            @click="openItem(item)"
          >
            <div class="feed-time">
              <span>{{ formatClock(item.createdAt) }}</span>
              <small>{{ formatTimeAgo(item.createdAt) }}</small>
            </div>

            <div class="feed-marker">
              <Icon
                :icon="kindIcon(item.kind)"
                class="w-4 h-4"
              />
            </div>

            <div class="feed-card">
              <div class="feed-card-top">
                <div class="feed-title-block">
                  <div class="feed-kicker">
                    <span class="kind-pill">
                      {{ item.kind }}
                    </span>
                    <span v-if="item.sourceLabel">
                      {{ item.sourceLabel }}
                    </span>
                  </div>

                  <h2>{{ item.title }}</h2>
                </div>

                <span
                  v-if="item.status"
                  class="status-pill"
                >
                  {{ item.status }}
                </span>

                <button
                  v-if="canStopItem(item)"
                  class="stop-button"
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

              <p
                v-if="item.description"
                class="feed-description"
              >
                {{ item.description }}
              </p>

              <div
                v-if="item.artifacts?.length"
                class="artifact-row"
              >
                <a
                  v-for="artifact in item.artifacts"
                  :key="artifact.href"
                  :href="artifact.href"
                  target="_blank"
                  rel="noreferrer"
                  class="artifact-link"
                  @click.stop
                >
                  <Icon
                    :icon="artifact.kind === 'image' ? 'lucide:image' : artifact.kind === 'video' ? 'lucide:film' : 'lucide:file'"
                    class="w-3.5 h-3.5"
                  />
                  <span>{{ artifact.label }}</span>
                  <span>{{ artifact.ext }}</span>
                </a>
              </div>

              <div class="feed-meta">
                <span>
                  <Icon
                    icon="lucide:user-round"
                    class="w-3 h-3"
                  />
                  {{ agentLabel(item) }}
                </span>

                <span v-if="item.conversationId || item.agentId">
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

<style scoped>.activity-view {
  height: 100%;
  overflow-y: auto;
  padding: 1.5rem 2rem 3rem;
}

.activity-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
  max-width: 72rem;
}

.activity-title {
  font-size: 1.45rem;
  font-weight: 750;
  color: var(--color-theme-100);
  letter-spacing: 0.02em;
}

.activity-subtitle {
  margin-top: 0.3rem;
  color: var(--color-theme-500);
  font-size: 0.875rem;
  max-width: 46rem;
}

.refresh-button,
.filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  border: 1px solid var(--color-theme-800);
  background: color-mix(in srgb, var(--color-theme-900) 82%, transparent);
  color: var(--color-theme-400);
  border-radius: 0.65rem;
  transition: 150ms ease;
}

.refresh-button {
  padding: 0.48rem 0.75rem;
  font-size: 0.8125rem;
}

.refresh-button:hover,
.filter-chip:hover {
  color: var(--color-theme-100);
  border-color: var(--color-theme-700);
  background: var(--color-theme-850, var(--color-theme-900));
}

.filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.55rem;
  margin-bottom: 1.35rem;
  max-width: 72rem;
}

.filter-chip {
  padding: 0.48rem 0.68rem;
  font-size: 0.8125rem;
  position: relative;
}

.filter-chip::before {
  content: "";
  width: 0.45rem;
  height: 0.45rem;
  border-radius: 999px;
  background: currentColor;
  opacity: 0.85;
}

.filter-chip.active {
  color: var(--color-accent-300);
  border-color: color-mix(in srgb, var(--color-accent-500) 50%, transparent);
  background: color-mix(in srgb, var(--color-accent-500) 13%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-accent-500) 12%, transparent) inset;
}

.filter-count {
  min-width: 1.3rem;
  padding: 0.08rem 0.38rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-theme-700) 55%, transparent);
  color: var(--color-theme-300);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
}

.activity-feed {
  max-width: 72rem;
}

.feed-group {
  margin-bottom: 1.4rem;
}

.feed-group-header {
  position: sticky;
  top: -1.5rem;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 1rem 0rem;
  color: var(--color-theme-500);
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.065em;
  background: var(--color-theme-900)
}

.feed-group-header span:last-child {
  color: var(--color-theme-650, var(--color-theme-600));
  font-weight: 600;
}

.feed-list {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.feed-item {
  display: grid;
  grid-template-columns: 4.2rem 2rem minmax(0, 1fr);
  gap: 0.75rem;
  align-items: stretch;
}

.feed-item.clickable {
  cursor: pointer;
}

.feed-time {
  padding-top: 0.85rem;
  text-align: right;
  color: var(--color-theme-500);
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}

.feed-time small {
  display: block;
  margin-top: 0.18rem;
  color: var(--color-theme-700);
  font-size: 0.67rem;
}

.feed-marker {
  width: 2rem;
  height: 2rem;
  margin-top: 0.62rem;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--activity-color);
  background: var(--activity-bg);
  border: 1px solid var(--activity-border);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--activity-color) 5%, transparent);
}

.feed-card {
  min-width: 0;
  position: relative;
  border: 1px solid var(--color-theme-850, var(--color-theme-800));
  border-left: 3px solid var(--activity-color);
  border-radius: 0.7rem;
  background: var(--color-theme-950);
  padding: 0.78rem 0.9rem 0.72rem;
  transition: 140ms ease;
}

.feed-item.clickable:hover .feed-card {
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

.feed-card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.9rem;
}

.feed-title-block {
  min-width: 0;
}

.feed-kicker {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.28rem;
  color: var(--color-theme-600);
  font-size: 0.7rem;
}

.kind-pill {
  color: var(--activity-color);
  font-weight: 750;
  text-transform: uppercase;
  letter-spacing: 0.055em;
}

.feed-card h2 {
  color: var(--color-theme-100);
  font-size: 0.94rem;
  font-weight: 720;
  line-height: 1.3;
}

.status-pill {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  padding: 0.16rem 0.45rem;
  border-radius: 999px;
  color: var(--activity-color);
  background: color-mix(in srgb, var(--activity-color) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--activity-color) 28%, transparent);
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: lowercase;
}

.stop-button {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.32rem;
  padding: 0.16rem 0.5rem;
  border-radius: 999px;
  color: #f87171;
  background: color-mix(in srgb, #f87171 9%, transparent);
  border: 1px solid color-mix(in srgb, #f87171 24%, transparent);
  font-size: 0.68rem;
  font-weight: 700;
  transition: 140ms ease;
}

.stop-button:hover:not(:disabled) {
  color: #fecaca;
  background: color-mix(in srgb, #f87171 16%, transparent);
  border-color: color-mix(in srgb, #f87171 42%, transparent);
}

.stop-button:disabled {
  cursor: wait;
  opacity: 0.72;
}

.feed-description {
  margin-top: 0.35rem;
  color: var(--color-theme-400);
  font-size: 0.81rem;
  line-height: 1.45;
}

.feed-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem 0.8rem;
  align-items: center;
  margin-top: 0.65rem;
  color: var(--color-theme-650, var(--color-theme-500));
  font-size: 0.72rem;
}

.feed-meta span {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}

.artifact-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  margin-top: 0.7rem;
}

.artifact-link {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  max-width: 18rem;
  padding: 0.32rem 0.48rem;
  border-radius: 0.45rem;
  background: color-mix(in srgb, var(--activity-color) 9%, var(--color-theme-850, var(--color-theme-800)));
  border: 1px solid color-mix(in srgb, var(--activity-color) 18%, transparent);
  color: var(--color-theme-200);
  font-size: 0.74rem;
}

.artifact-link span:nth-child(2) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-link span:last-child {
  color: var(--color-theme-500);
  font-size: 0.62rem;
  text-transform: uppercase;
}

.activity-info,
.activity-instance,
.activity-artifact,
.activity-notification,
.activity-cron,
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

.empty-state {
  min-height: 20rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  color: var(--color-theme-500);
  font-size: 0.875rem;
}

@media (max-width: 720px) {
  .activity-view {
    padding: 1rem;
  }

  .activity-header {
    flex-direction: column;
  }

  .refresh-button {
    width: 100%;
    justify-content: center;
  }

  .feed-item {
    grid-template-columns: 2rem minmax(0, 1fr);
  }

  .feed-time {
    display: none;
  }

  .feed-group-header {
    margin-left: 0;
  }
}
</style>
