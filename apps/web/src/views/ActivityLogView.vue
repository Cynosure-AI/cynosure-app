<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { Icon } from "@iconify/vue";
import { api } from "../api/client";
import type { ActivityItem, ActivityKind, ActivityTotalsByKind } from "../api/types";
import { useAgentDefinitionsStore } from "../stores/agent-definitions.store";
import { SK_ACTIVITY_LOG_FILTERS } from "../utils/storage-keys";
import HoverMenu from "../components/shared/HoverMenu.vue";

const router = useRouter();
const agentDefs = useAgentDefinitionsStore();

const items = ref<ActivityItem[]>([]);
const loading = ref(true);
const loadingMore = ref(false);
const hasMore = ref(false);
const totalItems = ref(0);
const searchQuery = ref("");
const now = ref(Date.now());
const stoppingIds = ref<Set<string>>(new Set());
const PAGE_SIZE = 30;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let unsubNotification: (() => void) | undefined;
let unsubMemoryJobUpdate: (() => void) | undefined;
let unsubHITLRequest: (() => void) | undefined;
let unsubExecutionUpdate: (() => void) | undefined;

const filterOptions: { value: ActivityKind; label: string; icon: string }[] = [
  { value: "instance", label: "Active", icon: "lucide:square-activity" },
  { value: "artifact", label: "Artifacts", icon: "lucide:file-output" },
  { value: "chat", label: "Chats", icon: "lucide:message-circle" },
  { value: "channels", label: "Channels", icon: "lucide:radio" },
  { value: "notification", label: "Notifications", icon: "lucide:bell" },
  { value: "cron", label: "Cron", icon: "lucide:clock" },
  { value: "memory", label: "Memory", icon: "lucide:brain" },
];

const defaultSelectedKinds: ActivityKind[] = filterOptions.map((option) => option.value);
const legacyDefaultSelectedKinds: ActivityKind[] = ["artifact", "channels", "notification", "cron", "memory"];
const previousDefaultSelectedKinds: ActivityKind[] = ["instance", ...legacyDefaultSelectedKinds];
const selectableKinds = new Set<ActivityKind>(filterOptions.map((option) => option.value));
const selectedKinds = ref<ActivityKind[]>(readSelectedKinds());

function readSelectedKinds(): ActivityKind[] {
  try {
    const raw = sessionStorage.getItem(SK_ACTIVITY_LOG_FILTERS);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [...defaultSelectedKinds];

    const validKinds = parsed.filter((value): value is ActivityKind =>
      typeof value === "string" && selectableKinds.has(value as ActivityKind),
    );
    const uniqueKinds = [...new Set(validKinds)];
    const matchesPriorDefault = [legacyDefaultSelectedKinds, previousDefaultSelectedKinds].some((defaults) =>
      uniqueKinds.length === defaults.length && defaults.every((kind) => uniqueKinds.includes(kind)),
    );
    return matchesPriorDefault ? [...defaultSelectedKinds] : uniqueKinds;
  } catch {
    return [...defaultSelectedKinds];
  }
}

function writeSelectedKinds(): void {
  try {
    sessionStorage.setItem(SK_ACTIVITY_LOG_FILTERS, JSON.stringify(selectedKinds.value));
  } catch {
    /* ignore storage failures */
  }
}

function emptyTotalsByKind(): ActivityTotalsByKind {
  return {
    instance: 0,
    artifact: 0,
    notification: 0,
    cron: 0,
    memory: 0,
    chat: 0,
    channels: 0,
  };
}

const totalByKind = ref<ActivityTotalsByKind>(emptyTotalsByKind());

const filteredItems = computed(() => {
  return items.value;
});

const allKindsSelected = computed(() => selectedKinds.value.length === filterOptions.length);
const defaultKindsSelected = computed(() =>
  selectedKinds.value.length === defaultSelectedKinds.length
  && defaultSelectedKinds.every((kind) => selectedKinds.value.includes(kind)),
);

const allActivityTotal = computed(() =>
  defaultSelectedKinds.reduce((total, kind) => total + totalByKind.value[kind], 0),
);

const selectedKindSummary = computed(() => {
  if (allKindsSelected.value || defaultKindsSelected.value) return "All Activity";
  if (selectedKinds.value.length === 0) return "No filters";
  if (selectedKinds.value.length === 1) {
    return filterOptions.find((option) => option.value === selectedKinds.value[0])?.label || "1 filter";
  }
  return `${selectedKinds.value.length} filters`;
});

function toggleKind(kind: ActivityKind): void {
  selectedKinds.value = selectedKinds.value.includes(kind)
    ? selectedKinds.value.filter((selected) => selected !== kind)
    : [...selectedKinds.value, kind];
}

function toggleAllKinds(): void {
  selectedKinds.value = allKindsSelected.value || defaultKindsSelected.value
    ? []
    : [...defaultSelectedKinds];
}

function clearSearch(): void {
  searchQuery.value = "";
}

function activityRequestOptions(offset = 0) {
  return {
    limit: PAGE_SIZE,
    offset,
    types: selectedKinds.value,
    search: searchQuery.value,
  };
}

async function loadActivity() {
  if (selectedKinds.value.length === 0) {
    items.value = [];
    hasMore.value = false;
    totalItems.value = 0;
    loading.value = false;
    return;
  }
  try {
    loading.value = true;
    const response = await api.activity.list(activityRequestOptions(0));
    items.value = response.items;
    hasMore.value = Boolean(response.hasMore);
    totalItems.value = response.total ?? response.items.length;
    totalByKind.value = response.totalsByKind ?? emptyTotalsByKind();
  } finally {
    loading.value = false;
  }
}

async function loadMoreActivity() {
  if (selectedKinds.value.length === 0 || loading.value || loadingMore.value || !hasMore.value) return;
  loadingMore.value = true;
  try {
    const response = await api.activity.list(activityRequestOptions(items.value.length));
    items.value = [...items.value, ...response.items];
    hasMore.value = Boolean(response.hasMore);
    totalItems.value = response.total ?? items.value.length;
    totalByKind.value = response.totalsByKind ?? totalByKind.value;
  } finally {
    loadingMore.value = false;
  }
}

function handleScroll(event: Event): void {
  const el = event.currentTarget as HTMLElement | null;
  if (!el) return;
  const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (distanceToBottom < 360) void loadMoreActivity();
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
  const activeItems = filteredItems.value.filter(isActiveInstance);
  if (activeItems.length) groups.push({ label: "Active now", items: activeItems });
  for (const item of filteredItems.value.filter((entry) => !isActiveInstance(entry))) {
    const label = formatDateLabel(item.createdAt);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
});

function kindIcon(kind: ActivityKind): string {
  switch (kind) {
    case "instance":
      return "lucide:square-activity";
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
    case "channels":
      return "lucide:radio";
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
  if (item.kind === "channels") return "activity-channels";
  return "activity-info";
}

function agentLabel(item: ActivityItem): string {
  if (item.agentName) return item.agentName;
  if (item.agentId) return agentDefs.get(item.agentId)?.name || "Agent";
  return item.kind === "memory" ? "Memory" : "System";
}

async function openItem(item: ActivityItem) {
  if (item.conversationId) {
    router.push(`/triggers/chat/${item.conversationId}`);
  } else if (item.agentId) {
    router.push(`/agents/${item.agentId}`);
  }
}

function isActiveInstance(item: ActivityItem): boolean {
  return item.kind === "instance" && (item.status === "running" || item.status === "awaiting-approval");
}

async function stopInstance(item: ActivityItem, event: Event): Promise<void> {
  event.stopPropagation();
  if (!item.sourceId || stoppingIds.value.has(item.sourceId)) return;
  stoppingIds.value.add(item.sourceId);
  try {
    await api.instances.stop(item.sourceId);
  } finally {
    stoppingIds.value.delete(item.sourceId);
    await loadActivity();
  }
}

function artifactIcon(kind: string): string {
  if (kind === "image") return "lucide:image";
  if (kind === "video") return "lucide:film";
  return "lucide:file";
}

function artifactTypeLabel(kind: string): string {
  if (kind === "video") return "Video";
  if (kind === "image") return "Image";
  return "File";
}

function isImageArtifact(kind: string): boolean {
  return kind === "image";
}

onMounted(() => {
  void loadActivity();
  refreshTimer = setInterval(() => void loadActivity(), 5_000);
  tickTimer = setInterval(() => {
    now.value = Date.now();
  }, 30_000);
  unsubNotification = api.notifications.onCreated(() => void loadActivity());
  unsubMemoryJobUpdate = api.memorySpaces.onJobUpdated(() => void loadActivity());
  unsubHITLRequest = api.agent.onHITLRequest(() => void loadActivity());
  unsubExecutionUpdate = api.agent.onExecutionUpdate((data: unknown) => {
    const payload = data as { event?: string };
    if (payload.event === "step:status" || payload.event === "task:completed" || payload.event === "step:executed") {
      void loadActivity();
    }
  });
});

onUnmounted(() => {
  clearInterval(refreshTimer);
  clearInterval(tickTimer);
  clearTimeout(searchTimer);
  unsubNotification?.();
  unsubMemoryJobUpdate?.();
  unsubHITLRequest?.();
  unsubExecutionUpdate?.();
});

watch(selectedKinds, () => {
  writeSelectedKinds();
  void loadActivity();
});

watch(searchQuery, () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void loadActivity(), 250);
});
</script>

<template>
  <div
    class="h-full overflow-y-auto px-4 py-4 pb-12 sm:px-8 sm:py-6"
    @scroll.passive="handleScroll"
  >
    <header class="mb-4 mx-auto flex max-w-6xl flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 class="text-[1.45rem] font-bold tracking-[0.02em] text-theme-100">
          Activity Log
        </h1>
        <p class="mt-1 max-w-3xl text-sm text-theme-500">
          Active work and a timeline of completed chats, cron runs, memory indexing, artifacts, channels, and notifications.
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

    <div class="mb-5 mx-auto flex max-w-6xl flex-col gap-2 sm:flex-row sm:items-center">
      <HoverMenu
        placement="below"
        :max-width="292"
        :close-delay="180"
      >
        <template #trigger="{ open, toggle }">
          <button
            type="button"
            class="inline-flex w-full items-center justify-between gap-3 rounded-lg border border-theme-800 bg-theme-900/80 px-3 py-2 text-[13px] text-theme-300 transition hover:border-theme-700 hover:bg-theme-800 hover:text-theme-100 sm:w-48"
            :class="{ 'filter-chip-active text-accent-700 dark:text-accent-300': selectedKinds.length > 0 }"
            aria-haspopup="menu"
            :aria-expanded="open"
            @click.stop="toggle"
          >
            <span class="inline-flex min-w-0 items-center gap-2">
              <Icon
                icon="lucide:list-filter"
                class="h-4 w-4 shrink-0"
              />
              <span class="truncate">{{ selectedKindSummary }}</span>
            </span>
            <span class="inline-flex shrink-0 items-center gap-1.5">
              <span class="rounded-full bg-theme-700/55 px-1.5 py-0.5 text-[11px] tabular-nums text-theme-300">
                {{ selectedKinds.length }}/{{ filterOptions.length }}
              </span>
              <Icon
                icon="lucide:chevron-down"
                class="h-3.5 w-3.5 text-theme-500 transition"
                :class="{ 'rotate-180': open }"
              />
            </span>
          </button>
        </template>

        <template #content>
          <div
            class="w-72"
            role="menu"
            @click.stop
          >
            <button
              type="button"
              class="mb-1 flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-[13px] text-theme-300 transition hover:bg-theme-800 hover:text-theme-100"
              :class="{ 'filter-menu-active text-accent-700 dark:text-accent-300': allKindsSelected || defaultKindsSelected }"
              @click="toggleAllKinds"
            >
              <span class="inline-flex items-center gap-2">
                <span class="flex h-4 w-4 items-center justify-center rounded border border-theme-600">
                  <Icon
                    v-if="allKindsSelected || defaultKindsSelected"
                    icon="lucide:check"
                    class="h-3 w-3"
                  />
                </span>
                <Icon
                  icon="lucide:list-filter"
                  class="h-3.5 w-3.5"
                />
                All Activity
              </span>
              <span class="rounded-full bg-theme-700/55 px-1.5 py-0.5 text-[11px] tabular-nums text-theme-400">{{ allActivityTotal }}</span>
            </button>

            <div class="my-1 h-px bg-theme-800" />

            <label
              v-for="option in filterOptions"
              :key="option.value"
              class="flex cursor-pointer items-center justify-between rounded-md px-2.5 py-2 text-[13px] text-theme-300 transition hover:bg-theme-800 hover:text-theme-100"
              :class="{ 'filter-menu-active text-accent-700 dark:text-accent-300': selectedKinds.includes(option.value) }"
            >
              <span class="inline-flex min-w-0 items-center gap-2">
                <span class="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-theme-600">
                  <Icon
                    v-if="selectedKinds.includes(option.value)"
                    icon="lucide:check"
                    class="h-3 w-3"
                  />
                </span>
                <Icon
                  :icon="option.icon"
                  class="h-3.5 w-3.5 shrink-0"
                />
                <span class="truncate">{{ option.label }}</span>
              </span>
              <span class="rounded-full bg-theme-700/55 px-1.5 py-0.5 text-[11px] tabular-nums text-theme-400">{{ totalByKind[option.value] }}</span>
              <input
                type="checkbox"
                class="sr-only"
                :checked="selectedKinds.includes(option.value)"
                @change="toggleKind(option.value)"
              >
            </label>
          </div>
        </template>
      </HoverMenu>

      <div class="relative min-w-0 flex-1">
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
            :class="[kindClass(item), {
              'cursor-pointer': item.conversationId || item.agentId,
              'activity-requires-attention': item.status === 'awaiting-approval',
            }]"
            @click="openItem(item)"
          >
            <div class="hidden pt-3.5 text-right text-xs tabular-nums text-theme-500 sm:block">
              <span>{{ formatClock(item.createdAt) }}</span>
              <small class="mt-0.5 block text-[10px] text-theme-700">{{ formatTimeAgo(item.createdAt) }}</small>
            </div>

            <div class="relative mt-2.5 flex h-8 w-8 items-center justify-center rounded-full border text-[var(--activity-color)] activity-marker">
              <Icon
                :icon="kindIcon(item.kind)"
                class="relative w-4 h-4"
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
                  <button
                    v-if="isActiveInstance(item)"
                    type="button"
                    class="inline-flex items-center gap-1.5 rounded-lg border border-red-400/35 bg-red-400/10 px-2.5 py-1 text-[11px] font-semibold text-red-300 transition hover:border-red-300/50 hover:bg-red-400/20 hover:text-red-200 disabled:cursor-wait disabled:opacity-60"
                    :disabled="Boolean(item.sourceId && stoppingIds.has(item.sourceId))"
                    @click="stopInstance(item, $event)"
                  >
                    <Icon
                      :icon="item.sourceId && stoppingIds.has(item.sourceId) ? 'lucide:loader-2' : 'lucide:square'"
                      class="h-3 w-3"
                      :class="{ 'animate-spin': item.sourceId && stoppingIds.has(item.sourceId) }"
                    />
                    Stop
                  </button>
                  <span
                    v-if="item.status"
                    class="status-pill shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold lowercase"
                    :class="{ 'attention-pill': item.status === 'awaiting-approval' }"
                  >
                    {{ item.status }}
                  </span>
                </div>
              </div>

              <p
                v-if="item.description"
                class="mt-1.5 text-[13px] leading-relaxed text-theme-400 wrap-break-word"
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
                  <span class="shrink-0 text-[10px] uppercase text-theme-500">{{ artifactTypeLabel(artifact.kind) }}</span>
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

      <div
        v-if="loadingMore"
        class="flex items-center justify-center gap-2 py-6 text-sm text-theme-500"
      >
        <Icon
          icon="lucide:loader-2"
          class="h-4 w-4 animate-spin"
        />
        Loading more activity...
      </div>

      <div
        v-else-if="hasMore"
        class="flex justify-center py-6"
      >
        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-lg border border-theme-800 bg-theme-900/80 px-3 py-2 text-[13px] text-theme-400 transition hover:border-theme-700 hover:bg-theme-800 hover:text-theme-100"
          @click="loadMoreActivity"
        >
          <Icon
            icon="lucide:chevrons-down"
            class="h-4 w-4"
          />
          Load more
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.filter-chip-active {
  border-color: color-mix(in srgb, var(--color-accent-500) 50%, transparent);
  background: color-mix(in srgb, var(--color-accent-500) 13%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-accent-500) 12%, transparent) inset;
}

.filter-menu-active {
  background: color-mix(in srgb, var(--color-accent-500) 10%, transparent);
}

.activity-marker {
  background: var(--activity-bg);
  border: 1px solid var(--activity-border);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--activity-color) 5%, transparent);
}

.activity-card {
  border-left: 3px solid var(--activity-color);
}

.activity-requires-attention .activity-card {
  border-color: color-mix(in srgb, var(--activity-color) 44%, var(--color-theme-800));
  background:
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--activity-color) 14%, transparent),
      transparent 42%
    ),
    var(--color-theme-950);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--activity-color) 22%, transparent),
    0 14px 32px color-mix(in srgb, var(--activity-color) 9%, transparent);
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

.attention-pill {
  color: #fde68a;
  background: color-mix(in srgb, #fbbf24 18%, transparent);
  border: 1px solid color-mix(in srgb, #fbbf24 44%, transparent);
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
.activity-channels,
.activity-memory,
.activity-warning,
.activity-critical {
  --activity-color: var(--color-accent-400);
  --activity-bg: color-mix(in srgb, var(--color-accent-500) 12%, var(--color-theme-950));
  --activity-border: color-mix(in srgb, var(--color-accent-500) 35%, var(--color-theme-800));
}

.activity-instance {
  --activity-color: #f87171;
  --activity-bg: color-mix(in srgb, #f87171 15%, var(--color-theme-950));
  --activity-border: color-mix(in srgb, #f87171 42%, var(--color-theme-800));
}

.activity-instance .activity-card {
  background:
    linear-gradient(90deg, color-mix(in srgb, #f87171 12%, transparent), transparent 42%),
    var(--color-theme-950);
  box-shadow: 0 0 0 1px color-mix(in srgb, #f87171 12%, transparent);
}

.activity-cron {
  --activity-color: #38bdf8;
  --activity-bg: color-mix(in srgb, #38bdf8 12%, var(--color-theme-950));
  --activity-border: color-mix(in srgb, #38bdf8 35%, var(--color-theme-800));
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

.activity-channels {
  --activity-color: #2dd4bf;
  --activity-bg: color-mix(in srgb, #2dd4bf 12%, var(--color-theme-950));
  --activity-border: color-mix(in srgb, #2dd4bf 35%, var(--color-theme-800));
}
</style>
