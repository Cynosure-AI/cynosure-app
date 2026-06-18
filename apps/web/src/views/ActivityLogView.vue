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
  if (item.kind === "notification" && item.severity === "critical") return "activity-critical";
  if (item.kind === "notification" && item.severity === "warning") return "activity-warning";
  if (item.kind === "instance" && item.status === "awaiting-approval") return "activity-warning";
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
      class="timeline"
    >
      <section
        v-for="group in groupedItems"
        :key="group.label"
        class="timeline-group"
      >
        <div class="group-label">
          <span>{{ group.label }}</span>
          <span>{{ group.items.length }}</span>
        </div>

        <div class="timeline-list">
          <article
            v-for="item in group.items"
            :key="item.id"
            class="timeline-item"
            :class="[kindClass(item), { clickable: item.conversationId || item.agentId }]"
            @click="openItem(item)"
          >
            <div class="timeline-marker">
              <Icon
                :icon="kindIcon(item.kind)"
                class="w-4 h-4"
              />
            </div>

            <div class="timeline-body">
              <div class="timeline-topline">
                <h2>{{ item.title }}</h2>
                <span>{{ formatTimeAgo(item.createdAt) }}</span>
              </div>

              <p
                v-if="item.description"
                class="timeline-description"
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

              <div class="timeline-meta">
                <span>
                  <Icon
                    icon="lucide:user-round"
                    class="w-3 h-3"
                  />
                  {{ agentLabel(item) }}
                </span>
                <span>
                  <Icon
                    icon="lucide:clock"
                    class="w-3 h-3"
                  />
                  {{ formatClock(item.createdAt) }}
                </span>
                <span v-if="item.sourceLabel">
                  {{ item.sourceLabel }}
                </span>
                <span
                  v-if="item.status"
                  class="status-pill"
                >
                  {{ item.status }}
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
.activity-view {
  height: 100%;
  overflow-y: auto;
  padding: 1.5rem 2rem;
}

.activity-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}

.activity-title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--color-theme-100);
}

.activity-subtitle {
  margin-top: 0.25rem;
  color: var(--color-theme-500);
  font-size: 0.875rem;
}

.refresh-button,
.filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  border: 1px solid var(--color-theme-800);
  background: var(--color-theme-900);
  color: var(--color-theme-400);
  border-radius: 0.5rem;
  transition: 150ms ease;
}

.refresh-button {
  padding: 0.45rem 0.75rem;
  font-size: 0.8125rem;
}

.refresh-button:hover,
.filter-chip:hover {
  color: var(--color-theme-100);
  background: var(--color-theme-800);
}

.filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
}

.filter-chip {
  padding: 0.45rem 0.65rem;
  font-size: 0.8125rem;
}

.filter-chip.active {
  color: var(--color-accent-300);
  border-color: color-mix(in srgb, var(--color-accent-500) 45%, transparent);
  background: color-mix(in srgb, var(--color-accent-500) 12%, transparent);
}

.filter-count {
  min-width: 1.25rem;
  padding: 0.05rem 0.35rem;
  border-radius: 999px;
  background: var(--color-theme-800);
  color: var(--color-theme-400);
  font-size: 0.6875rem;
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

.timeline {
  max-width: 58rem;
}

.timeline-group {
  margin-bottom: 1.5rem;
}

.group-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--color-theme-500);
  font-size: 0.75rem;
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin: 0 0 0.65rem 2.1rem;
}

.group-label span:last-child {
  color: var(--color-theme-600);
}

.timeline-list {
  position: relative;
}

.timeline-list::before {
  content: "";
  position: absolute;
  left: 0.95rem;
  top: 0.5rem;
  bottom: 0.5rem;
  width: 1px;
  background: var(--color-theme-800);
}

.timeline-item {
  position: relative;
  display: grid;
  grid-template-columns: 2rem minmax(0, 1fr);
  gap: 0.85rem;
  padding: 0.2rem 0 0.9rem;
}

.timeline-item.clickable {
  cursor: pointer;
}

.timeline-marker {
  z-index: 1;
  width: 2rem;
  height: 2rem;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--activity-color);
  background: var(--activity-bg);
  border: 1px solid var(--activity-border);
}

.timeline-body {
  min-width: 0;
  border: 1px solid var(--color-theme-800);
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--color-theme-900) 78%, transparent);
  padding: 0.85rem 0.95rem;
  transition: 150ms ease;
}

.timeline-item.clickable:hover .timeline-body {
  border-color: var(--color-theme-700);
  background: var(--color-theme-900);
}

.timeline-topline {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.timeline-topline h2 {
  color: var(--color-theme-100);
  font-size: 0.9375rem;
  font-weight: 650;
  line-height: 1.35;
}

.timeline-topline span {
  flex-shrink: 0;
  color: var(--color-theme-600);
  font-size: 0.75rem;
}

.timeline-description {
  margin-top: 0.25rem;
  color: var(--color-theme-400);
  font-size: 0.8125rem;
  line-height: 1.45;
}

.artifact-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  margin-top: 0.75rem;
}

.artifact-link {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  max-width: 18rem;
  padding: 0.3rem 0.45rem;
  border-radius: 0.375rem;
  background: var(--color-theme-800);
  color: var(--color-theme-200);
  font-size: 0.75rem;
}

.artifact-link span:nth-child(2) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-link span:last-child {
  color: var(--color-theme-500);
  font-size: 0.625rem;
}

.timeline-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem 0.75rem;
  align-items: center;
  margin-top: 0.75rem;
  color: var(--color-theme-600);
  font-size: 0.75rem;
}

.timeline-meta span {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}

.status-pill {
  color: var(--activity-color);
}

.activity-info,
.activity-artifact,
.activity-cron,
.activity-memory,
.activity-warning,
.activity-critical {
  --activity-color: var(--color-accent-400);
  --activity-bg: color-mix(in srgb, var(--color-accent-500) 12%, var(--color-theme-950));
  --activity-border: color-mix(in srgb, var(--color-accent-500) 35%, var(--color-theme-800));
}

.activity-artifact {
  --activity-color: #38bdf8;
  --activity-bg: color-mix(in srgb, #38bdf8 12%, var(--color-theme-950));
  --activity-border: color-mix(in srgb, #38bdf8 35%, var(--color-theme-800));
}

.activity-cron {
  --activity-color: #22c55e;
  --activity-bg: color-mix(in srgb, #22c55e 12%, var(--color-theme-950));
  --activity-border: color-mix(in srgb, #22c55e 35%, var(--color-theme-800));
}

.activity-memory {
  --activity-color: #a78bfa;
  --activity-bg: color-mix(in srgb, #a78bfa 12%, var(--color-theme-950));
  --activity-border: color-mix(in srgb, #a78bfa 35%, var(--color-theme-800));
}

.activity-warning {
  --activity-color: #f59e0b;
  --activity-bg: color-mix(in srgb, #f59e0b 12%, var(--color-theme-950));
  --activity-border: color-mix(in srgb, #f59e0b 38%, var(--color-theme-800));
}

.activity-critical {
  --activity-color: #f87171;
  --activity-bg: color-mix(in srgb, #f87171 12%, var(--color-theme-950));
  --activity-border: color-mix(in srgb, #f87171 38%, var(--color-theme-800));
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
}
</style>
