<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api/client";
import type { AgentInstance } from "../api/types";
import { useChatStore } from "../stores/chat.store";
import { useAgentDefinitionsStore } from "../stores/agent-definitions.store";
import { Icon } from "@iconify/vue";
import BaseCard from "../components/shared/BaseCard.vue";
import DataTable, { type Column } from "../components/shared/DataTable.vue";

const router = useRouter();
const chatStore = useChatStore();
const agentDefs = useAgentDefinitionsStore();

// ── Running instances ──
const instances = ref<AgentInstance[]>([]);
const loading = ref(true);
const now = ref(Date.now());

let pollTimer: ReturnType<typeof setInterval> | undefined;
let historyPollTimer: ReturnType<typeof setInterval> | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let unsubHITLRequest: (() => void) | undefined;
let unsubExecutionUpdate: (() => void) | undefined;

async function loadInstances() {
  try {
    instances.value = await api.instances.list();
  } catch {
    // silently ignore
  } finally {
    loading.value = false;
  }
}

// ── History (paginated conversations) ──
const PAGE_SIZE = 20;

interface HistoryItem {
  id: string;
  title: string;
  agent_id: string | null;
  origin: string;
  pinned: number;
  updated_at: number;
  last_read_at: number | null;
  last_user_message: string | null;
}

const historyItems = ref<HistoryItem[]>([]);
const historyTotal = ref(0);
const historyPage = ref(1);
const historyLoading = ref(false);
const selectedTimelineIds = ref<string[]>([]);
const bulkDeleting = ref(false);
const bulkMarkingRead = ref(false);
const historyPages = computed(() =>
  Math.max(1, Math.ceil(historyTotal.value / PAGE_SIZE)),
);

async function loadHistory() {
  historyLoading.value = true;
  try {
    const offset = (historyPage.value - 1) * PAGE_SIZE;
    const res = await api.chat.listConversationsPaginated(
      PAGE_SIZE,
      offset,
      "updated",
    );
    historyItems.value = res.items;
    historyTotal.value = res.total;
    pruneTimelineSelection();
  } catch {
    // silently ignore
  } finally {
    historyLoading.value = false;
  }
}

function goToPage(page: number) {
  historyPage.value = page;
  loadHistory();
}

// ── Formatting ──
function formatStarted(ts: number): string {
  const d = new Date(ts);
  const timeStr = d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (d.toDateString() === new Date().toDateString()) return `Today ${timeStr}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${timeStr}`;
}

function formatDuration(startedAt: number): string {
  const secs = Math.floor(Math.max(0, now.value - startedAt) / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  if (days > 0) return `${days}d ${hrs % 24}h`;
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m`;
  return `${secs}s`;
}

function formatTimeAgo(ts: number): string {
  const mins = Math.floor(Math.max(0, Date.now() - ts) / 60_000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  if (days > 0) return `${days}d ago`;
  if (hrs > 0) return `${hrs}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "Just now";
}

// ── Origin badge config (only origins that get a badge) ──
const originBadgeConfig: Record<
  string,
  { icon: string; color: string; bg: string; label: string }
> = {
  chat: {
    icon: "lucide:message-circle",
    color: "text-accent-400",
    bg: "bg-accent-500/10",
    label: "Chat",
  },
  "multi-agent": {
    icon: "lucide:network",
    color: "text-purple-400",
    bg: "bg-purple-500/10",
    label: "Multi-Agent",
  },
  cron: {
    icon: "lucide:clock",
    color: "text-sky-400",
    bg: "bg-sky-500/10",
    label: "Cron",
  },
  channel: {
    icon: "lucide:send",
    color: "text-teal-400",
    bg: "bg-teal-500/10",
    label: "Channel",
  },
};

// Only channel/cron get badges on history rows
const HISTORY_BADGE_ORIGINS = new Set(["channel", "cron"]);

// ── Timeline ──
type TimelineItem =
  | { id: string; kind: "running"; ts: number; running: AgentInstance }
  | { id: string; kind: "history"; ts: number; history: HistoryItem };

function timelineEntryName(item: TimelineItem): string {
  return item.kind === "running"
    ? item.running.agentName
    : item.history.title || "Untitled";
}

function timelineDetails(item: TimelineItem): string {
  if (item.kind === "running") {
    return item.running.model || agentById.value[item.running.agentId]?.model || "";
  }

  const agent = item.history.agent_id ? agentById.value[item.history.agent_id] : null;
  return `${agent?.name || "Free Chat"} ${agent?.model || ""}`.trim();
}

function timelineType(item: TimelineItem): string {
  return item.kind === "running" ? item.running.type : item.history.origin || "chat";
}

function timelineStatus(item: TimelineItem): number {
  if (item.kind === "history") return 0;
  return item.running.status === "awaiting-approval" ? 2 : 1;
}

const timelineColumns: Column<TimelineItem>[] = [
  { key: "entry", label: "Entry", width: "minmax(0, 2.2fr)", sortable: true, sortValue: timelineEntryName },
  {
    key: "details",
    label: "Details",
    width: "minmax(0, 1.7fr)",
    sortable: true,
    sortValue: timelineDetails,
  },
  { key: "time", label: "Time", width: "180px", sortable: true, sortValue: item => item.ts },
  {
    key: "type",
    label: "Type",
    width: "80px",
    sortable: true,
    sortValue: timelineType,
  },
  { key: "status", label: "Status", width: "170px", sortable: true, sortValue: timelineStatus },
];

// Cache agent lookups so the template doesn't call agentDefs.get() repeatedly per row
const agentById = computed(() => {
  const ids = new Set([
    ...instances.value.map((i) => i.agentId),
    ...historyItems.value.map((i) => i.agent_id).filter(Boolean),
  ]);
  return Object.fromEntries([...ids].map((id) => [id, agentDefs.get(id!)]));
});

const runningConversationIds = computed(
  () =>
    new Set(
      instances.value
        .map((i) => i.conversationId)
        .filter((id): id is string => Boolean(id)),
    ),
);

function isHistoryItemUnread(item: HistoryItem): boolean {
  return !item.last_read_at || item.updated_at > item.last_read_at;
}

const timelineItems = computed<TimelineItem[]>(() => {
  const running: TimelineItem[] = [...instances.value]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((inst) => ({
      id: `running:${inst.id}`,
      kind: "running",
      ts: inst.startedAt,
      running: inst,
    }));

  const history: TimelineItem[] = [...historyItems.value]
    .filter((item) => !runningConversationIds.value.has(item.id))
    .sort((a, b) => b.updated_at - a.updated_at)
    .map((item) => ({
      id: `history:${item.id}`,
      kind: "history",
      ts: item.updated_at,
      history: item,
    }));

  return [...running, ...history];
});

const showLoading = computed(
  () =>
    (loading.value || historyLoading.value) && timelineItems.value.length === 0,
);

const selectedTimelineItems = computed(() => {
  const selected = new Set(selectedTimelineIds.value);
  return timelineItems.value.filter((item) => selected.has(item.id));
});

const selectedHistoryItems = computed(() =>
  selectedTimelineItems.value
    .filter((item): item is Extract<TimelineItem, { kind: "history" }> => item.kind === "history")
    .map((item) => item.history),
);

const selectedDeletableHistoryItems = computed(() =>
  selectedHistoryItems.value.filter((item) => !item.pinned),
);

const selectedUnreadHistoryItems = computed(() =>
  selectedHistoryItems.value.filter(isHistoryItemUnread),
);

const hasBulkSelection = computed(() => selectedTimelineIds.value.length > 0);

function pruneTimelineSelection() {
  const validIds = new Set(timelineItems.value.map((item) => item.id));
  selectedTimelineIds.value = selectedTimelineIds.value.filter((id) => validIds.has(id));
}

function clearTimelineSelection() {
  selectedTimelineIds.value = [];
}

async function markSelectedHistoryRead() {
  if (bulkMarkingRead.value || selectedUnreadHistoryItems.value.length === 0) return;
  bulkMarkingRead.value = true;
  try {
    const nowTs = Date.now();
    await Promise.all(selectedUnreadHistoryItems.value.map((item) => api.chat.markConversationRead(item.id)));
    const readIds = new Set(selectedUnreadHistoryItems.value.map((item) => item.id));
    for (const item of historyItems.value) {
      if (readIds.has(item.id)) item.last_read_at = nowTs;
    }
    await chatStore.loadConversations();
  } catch {
    // non-critical; the next poll will refresh the timeline
  } finally {
    bulkMarkingRead.value = false;
  }
}

async function deleteSelectedHistory() {
  if (bulkDeleting.value || selectedDeletableHistoryItems.value.length === 0) return;
  bulkDeleting.value = true;
  try {
    const ids = selectedDeletableHistoryItems.value.map((item) => item.id);
    await Promise.all(ids.map((id) => api.chat.deleteConversation(id)));
    historyItems.value = historyItems.value.filter((item) => !ids.includes(item.id));
    historyTotal.value = Math.max(0, historyTotal.value - ids.length);
    selectedTimelineIds.value = selectedTimelineIds.value.filter((id) => !ids.some((historyId) => id === `history:${historyId}`));
    await chatStore.loadConversations();
  } catch {
    await loadHistory();
  } finally {
    bulkDeleting.value = false;
  }
}

// ── Navigation ──
async function openInstance(instance: AgentInstance) {
  await chatStore.setActiveAgent(instance.agentId || null);
  if (instance.conversationId)
    await chatStore.selectConversation(instance.conversationId);
  router.push("/triggers/chat");
}

async function openConversation(item: HistoryItem) {
  await chatStore.setActiveAgent(item.agent_id);
  await chatStore.selectConversation(item.id);
  router.push("/triggers/chat");
}

function openTimelineItem(item: TimelineItem) {
  if (item.kind === "running") void openInstance(item.running);
  else void openConversation(item.history);
}

// ── Stop ──
const stopping = ref<Set<string>>(new Set());

async function stopInstance(inst: AgentInstance, event: Event) {
  event.stopPropagation();
  if (stopping.value.has(inst.id)) return;
  stopping.value.add(inst.id);
  try {
    await api.instances.stop(inst.id);
    await Promise.all([loadInstances(), loadHistory()]);
  } catch {
    // silently ignore — instance may have already finished
  } finally {
    stopping.value.delete(inst.id);
  }
}

onMounted(() => {
  loadInstances();
  loadHistory();
  pollTimer = setInterval(loadInstances, 3_000);
  historyPollTimer = setInterval(loadHistory, 15_000);
  tickTimer = setInterval(() => {
    now.value = Date.now();
  }, 1_000);
  unsubHITLRequest = api.agent.onHITLRequest(() => loadInstances());
  unsubExecutionUpdate = api.agent.onExecutionUpdate((data: unknown) => {
    const d = data as { event?: string; data?: { status?: string } };
    if (d.event === "step:status" && d.data?.status !== "awaiting-approval") {
      void Promise.all([loadInstances(), loadHistory()]);
    }
  });
});

onUnmounted(() => {
  clearInterval(pollTimer);
  clearInterval(historyPollTimer);
  clearInterval(tickTimer);
  unsubHITLRequest?.();
  unsubExecutionUpdate?.();
});
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-6xl mx-auto py-8 px-6">
      <div class="mb-6">
        <h1 class="text-2xl font-bold text-theme-100">
          Instances Timeline
        </h1>
        <p class="text-sm text-theme-500 mt-1">
          Running instances are pinned on top, with historical entries below in
          chronological order.
        </p>
      </div>

      <!-- Loading -->
      <BaseCard
        v-if="showLoading"
        class="p-12 text-center"
      >
        <Icon
          icon="lucide:loader-2"
          class="w-8 h-8 text-theme-500 animate-spin mx-auto mb-3"
        />
        <p class="text-sm text-theme-500">
          Loading timeline…
        </p>
      </BaseCard>

      <!-- Empty state -->
      <BaseCard
        v-else-if="timelineItems.length === 0"
        class="p-12 text-center"
      >
        <div
          class="w-16 h-16 rounded-2xl bg-theme-800 flex items-center justify-center mx-auto mb-4"
        >
          <Icon
            icon="lucide:activity"
            class="w-8 h-8 text-theme-600"
          />
        </div>
        <h3 class="text-lg font-medium text-theme-200 mb-2">
          No timeline entries yet
        </h3>
        <p class="text-sm text-theme-500 max-w-md mx-auto">
          Running instances and recent conversations will appear here.
        </p>
      </BaseCard>

      <template v-else>
        <DataTable
          v-model:selected-ids="selectedTimelineIds"
          :items="timelineItems"
          :columns="timelineColumns"
          selectable
          empty-message="No timeline entries"
          @row-click="openTimelineItem"
        >
          <!-- Entry -->
          <template #col-entry="{ item }">
            <div class="flex items-center gap-3 min-w-0">
              <img
                v-if="item.kind === 'running' && item.running.agentIconUrl"
                :src="item.running.agentIconUrl"
                :alt="item.running.agentName"
                class="w-10 h-10 rounded-xl object-cover shrink-0"
              >
              <img
                v-else-if="
                  item.kind === 'history' &&
                    agentById[item.history.agent_id!]?.iconUrl
                "
                :src="agentById[item.history.agent_id!]!.iconUrl!"
                :alt="agentById[item.history.agent_id!]?.name"
                class="w-10 h-10 rounded-xl object-cover shrink-0"
              >
              <div
                v-else
                class="w-10 h-10 rounded-xl bg-theme-800 flex items-center justify-center shrink-0"
              >
                <Icon
                  :icon="
                    item.kind === 'running'
                      ? 'lucide:bot'
                      : 'lucide:message-circle'
                  "
                  class="w-5 h-5 text-theme-500"
                />
              </div>
              <div class="min-w-0">
                <div class="flex items-center gap-1.5">
                  <span
                    v-if="item.kind === 'history' && isHistoryItemUnread(item.history)"
                    class="w-2 h-2 rounded-full bg-accent-400 shrink-0"
                    title="Unread"
                  />
                  <span class="text-sm font-medium text-theme-200 truncate">
                    {{
                      item.kind === "running"
                        ? item.running.agentName
                        : item.history.title || "Untitled"
                    }}
                  </span>
                </div>
                <div
                  v-if="
                    item.kind === 'history' && item.history.last_user_message
                  "
                  class="text-xs text-theme-500 truncate mt-0.5"
                >
                  {{ item.history.last_user_message }}
                </div>
              </div>
            </div>
          </template>

          <!-- Type -->
          <template #col-type="{ item }">
            <div class="flex items-center gap-1.5">
              <template v-if="item.kind === 'running'">
                <span
                  v-if="originBadgeConfig[item.running.type]"
                  :class="[
                    originBadgeConfig[item.running.type].bg,
                    originBadgeConfig[item.running.type].color,
                  ]"
                  class="text-[10px] font-medium px-2 py-0.5 rounded-full"
                >
                  {{ originBadgeConfig[item.running.type].label }}
                </span>
              </template>
              <template v-else>
                <span
                  v-if="
                    HISTORY_BADGE_ORIGINS.has(item.history.origin) &&
                      originBadgeConfig[item.history.origin]
                  "
                  :class="[
                    originBadgeConfig[item.history.origin].bg,
                    originBadgeConfig[item.history.origin].color,
                  ]"
                  class="text-[10px] font-medium px-2 py-0.5 rounded-full"
                >
                  {{ originBadgeConfig[item.history.origin].label }}
                </span>
                <span
                  v-else
                  class="text-[10px] font-medium px-2 py-0.5 rounded-full bg-theme-700/50 text-theme-400"
                >
                  Chat
                </span>
              </template>
            </div>
          </template>

          <!-- Details -->
          <template #col-details="{ item }">
            <div class="flex flex-wrap items-center gap-1.5">
              <!-- Agent info -->
              <template v-if="item.kind === 'running'">
                <span
                  v-if="
                    agentById[item.running.agentId]?.model || item.running.model
                  "
                  class="text-xs text-theme-500 truncate max-w-50"
                >
                  {{
                    item.running.model || agentById[item.running.agentId]?.model
                  }}
                </span>
              </template>
              <template v-else>
                <span
                  v-if="
                    item.history.agent_id && agentById[item.history.agent_id]
                  "
                  class="text-[10px] font-medium px-2 py-0.5 rounded-full bg-accent-500/10 text-accent-400"
                >
                  {{ agentById[item.history.agent_id]!.name }}
                </span>
                <span
                  v-else-if="!item.history.agent_id"
                  class="text-[10px] font-medium px-2 py-0.5 rounded-full bg-theme-700/50 text-theme-400"
                >
                  Free Chat
                </span>
                <span
                  v-if="agentById[item.history.agent_id!]?.model"
                  class="text-xs text-theme-500 truncate max-w-50"
                >
                  {{ agentById[item.history.agent_id!]!.model }}
                </span>
              </template>
            </div>
          </template>

          <!-- Time — use item.ts directly, avoids per-kind ternaries -->
          <template #col-time="{ item }">
            <div class="text-xs text-theme-400">
              {{ formatStarted(item.ts) }}
            </div>
            <div class="text-xs text-theme-600 mt-0.5">
              {{
                item.kind === "running"
                  ? formatDuration(item.ts)
                  : formatTimeAgo(item.ts)
              }}
            </div>
          </template>

          <!-- Status -->
          <template #col-status="{ item }">
            <div class="flex items-center justify-between gap-3">
              <div class="flex items-center gap-1.5">
                <template
                  v-if="
                    item.kind === 'running' &&
                      item.running.status === 'awaiting-approval'
                  "
                >
                  <span
                    class="w-2 h-2 rounded-full bg-amber-500 animate-pulse"
                  />
                  <span class="text-xs text-amber-400">Awaiting Approval</span>
                </template>
                <template v-else-if="item.kind === 'running'">
                  <span
                    class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"
                  />
                  <span class="text-xs text-emerald-400">Running</span>
                </template>
                <template v-else>
                  <span class="w-2 h-2 rounded-full bg-theme-500" />
                  <span class="text-xs text-theme-400">Completed</span>
                </template>
              </div>
              <button
                v-if="item.kind === 'running'"
                class="shrink-0 p-1.5 rounded-lg text-theme-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                :class="{ 'text-red-400': stopping.has(item.running.id) }"
                title="Stop instance"
                @click="stopInstance(item.running, $event)"
              >
                <Icon
                  :icon="
                    stopping.has(item.running.id)
                      ? 'lucide:loader-2'
                      : 'lucide:square'
                  "
                  class="w-4 h-4"
                  :class="{ 'animate-spin': stopping.has(item.running.id) }"
                />
              </button>
              <Icon
                v-else
                icon="lucide:chevron-right"
                class="w-4 h-4 text-theme-600"
              />
            </div>
          </template>
        </DataTable>

        <div
          v-if="hasBulkSelection"
          class="sticky bottom-4 z-10 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-theme-700 bg-theme-900/95 px-4 py-3 shadow-xl shadow-black/20 backdrop-blur"
        >
          <div class="text-sm text-theme-300">
            {{ selectedTimelineIds.length }} selected
            <span
              v-if="selectedTimelineItems.length !== selectedHistoryItems.length"
              class="text-theme-500"
            >
              · {{ selectedTimelineItems.length - selectedHistoryItems.length }} running
            </span>
          </div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-lg border border-theme-700 px-3 py-1.5 text-xs text-theme-300 transition-colors hover:border-theme-600 hover:text-theme-100 disabled:opacity-40 disabled:pointer-events-none"
              :disabled="bulkMarkingRead || selectedUnreadHistoryItems.length === 0"
              @click="markSelectedHistoryRead"
            >
              <Icon
                :icon="bulkMarkingRead ? 'lucide:loader-2' : 'lucide:check-check'"
                class="h-3.5 w-3.5"
                :class="{ 'animate-spin': bulkMarkingRead }"
              />
              Mark read
            </button>
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 px-3 py-1.5 text-xs text-red-300 transition-colors hover:bg-red-500/10 disabled:opacity-40 disabled:pointer-events-none"
              :disabled="bulkDeleting || selectedDeletableHistoryItems.length === 0"
              @click="deleteSelectedHistory"
            >
              <Icon
                :icon="bulkDeleting ? 'lucide:loader-2' : 'lucide:trash-2'"
                class="h-3.5 w-3.5"
                :class="{ 'animate-spin': bulkDeleting }"
              />
              Delete
            </button>
            <button
              type="button"
              class="p-1.5 text-theme-500 transition-colors hover:text-theme-200"
              title="Clear selection"
              @click="clearTimelineSelection"
            >
              <Icon
                icon="lucide:x"
                class="h-4 w-4"
              />
            </button>
          </div>
        </div>

        <!-- Pagination -->
        <div
          v-if="historyPages > 1"
          class="flex items-center justify-center gap-2 mt-6"
        >
          <button
            class="px-3 py-1.5 text-sm rounded-lg border border-theme-700 text-theme-400 hover:text-theme-200 hover:border-theme-600 transition-colors disabled:opacity-40 disabled:pointer-events-none"
            :disabled="historyPage <= 1"
            @click="goToPage(historyPage - 1)"
          >
            <Icon
              icon="lucide:chevron-left"
              class="w-4 h-4"
            />
          </button>
          <span class="text-sm text-theme-500">Page {{ historyPage }} of {{ historyPages }}</span>
          <button
            class="px-3 py-1.5 text-sm rounded-lg border border-theme-700 text-theme-400 hover:text-theme-200 hover:border-theme-600 transition-colors disabled:opacity-40 disabled:pointer-events-none"
            :disabled="historyPage >= historyPages"
            @click="goToPage(historyPage + 1)"
          >
            <Icon
              icon="lucide:chevron-right"
              class="w-4 h-4"
            />
          </button>
        </div>
      </template>
    </div>
  </div>
</template>
