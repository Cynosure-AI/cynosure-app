<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useNotificationStore } from "../stores/notification.store";
import { useAgentDefinitionsStore } from "../stores/agent-definitions.store";
import { useChatStore } from "../stores/chat.store";
import { Icon } from "@iconify/vue";
import ModalDialog from "../components/shared/ModalDialog.vue";

const router = useRouter();
const notificationStore = useNotificationStore();
const agentDefs = useAgentDefinitionsStore();
const chatStore = useChatStore();

const showClearConfirm = ref(false);
const clearing = ref(false);
const clearError = ref("");

function openClearConfirm(): void {
  clearError.value = "";
  showClearConfirm.value = true;
}

async function clearAll(): Promise<void> {
  clearing.value = true;
  clearError.value = "";
  try {
    await notificationStore.removeAll();
    showClearConfirm.value = false;
  } catch (error) {
    clearError.value = `Notifications were not cleared: ${error instanceof Error ? error.message : "unknown error"}`;
  } finally {
    clearing.value = false;
  }
}

onMounted(() => {
  if (!notificationStore.loaded) {
    notificationStore.load();
  }
});

function notificationTime(n: (typeof notificationStore.notifications)[0]): number {
  return n.createdAt;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Group notifications by calendar day (descending) */
function groupedNotifications() {
  const groups: { label: string; items: typeof notificationStore.notifications }[] = [];
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  for (const n of notificationStore.notifications) {
    const time = notificationTime(n);
    const date = new Date(time);
    let label: string;
    if (date.toDateString() === today.toDateString()) {
      label = "Today";
    } else if (date.toDateString() === yesterday.toDateString()) {
      label = "Yesterday";
    } else {
      label = formatDate(time);
    }
    const last = groups[groups.length - 1];
    if (last && last.label === label) {
      last.items.push(n);
    } else {
      groups.push({ label, items: [n] });
    }
  }
  return groups;
}

async function openNotification(n: (typeof notificationStore.notifications)[0]) {
  if (!n.read) {
    await notificationStore.markRead(n.id);
  }
  if (n.conversationId) {
    await chatStore.setActiveAgent(n.agentId || null);
    await chatStore.selectConversation(n.conversationId);
    router.push(`/chat/${encodeURIComponent(n.conversationId)}`);
  } else if (n.agentId) {
    router.push(`/agents/${n.agentId}`);
  }
}

function priorityIcon(priority: string): string {
  switch (priority) {
    case "alert":
      return "lucide:alert-triangle";
    case "action":
      return "lucide:circle-alert";
    default:
      return "lucide:info";
  }
}

function priorityClass(priority: string): string {
  switch (priority) {
    case "alert":
      return "priority-alert";
    case "action":
      return "priority-action";
    default:
      return "priority-notice";
  }
}
</script>

<template>
  <div class="h-full overflow-y-auto">
    <header class="page-header z-10 border-b border-theme-800/60 bg-theme-950/95 py-4 backdrop-blur-sm sm:sticky sm:top-0 sm:py-5">
      <div class="mx-auto flex max-w-7xl flex-col gap-4 px-4 sm:flex-row sm:items-start sm:justify-between sm:px-6 lg:px-8">
        <div>
          <h1 class="text-2xl font-bold text-theme-100">
            Notifications
          </h1>
          <p class="mt-1 text-sm leading-relaxed text-ink-muted">
            Messages from your agents and scheduled jobs.
            <span v-if="notificationStore.notifications.length">
              {{ notificationStore.notifications.length }} total{{ notificationStore.unreadCount ? `, ${notificationStore.unreadCount} unread` : "" }}.
            </span>
          </p>
        </div>
        <div
          v-if="notificationStore.notifications.length > 0"
          class="flex gap-2"
        >
          <button
            v-if="notificationStore.unreadCount > 0"
            type="button"
            class="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-theme-800 bg-theme-900/80 px-3 py-2 text-[13px] text-ink-secondary transition hover:border-theme-700 hover:bg-theme-800 hover:text-theme-100 sm:flex-none"
            @click="notificationStore.markAllRead()"
          >
            <Icon
              icon="lucide:check-check"
              class="h-4 w-4"
            />
            Mark all read
          </button>
          <button
            type="button"
            class="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-theme-800 bg-theme-900/80 px-3 py-2 text-[13px] text-ink-secondary transition hover:border-red-400/35 hover:bg-red-400/10 hover:text-red-300 sm:flex-none"
            @click="openClearConfirm"
          >
            <Icon
              icon="lucide:trash-2"
              class="h-4 w-4"
            />
            Clear all
          </button>
        </div>
      </div>
    </header>

    <div class="notifications-view mx-auto max-w-7xl px-4 py-6 pb-12 sm:px-6 lg:px-8">
      <!-- Empty state -->
      <div
        v-if="notificationStore.notifications.length === 0"
        class="empty-state"
      >
        <Icon
          icon="lucide:bell-off"
          class="empty-icon"
        />
        <p class="empty-title">
          All caught up!
        </p>
        <p class="empty-desc">
          No notifications to show right now.
        </p>
      </div>

      <!-- Notification Grid (grouped by day) -->
      <div
        v-for="group in groupedNotifications()"
        :key="group.label"
        class="notification-group"
      >
        <div class="group-header">
          <span class="group-label">{{ group.label }}</span>
          <span class="group-count">{{ group.items.length }}</span>
        </div>
        <div class="notification-grid">
          <div
            v-for="n in group.items"
            :key="n.id"
            class="notification-card"
            :class="[priorityClass(n.priority), { unread: !n.read }]"
            role="button"
            tabindex="0"
            @click="openNotification(n)"
            @keydown.enter.prevent="openNotification(n)"
            @keydown.space.prevent="openNotification(n)"
          >
            <div class="card-left">
              <div class="priority-icon">
                <Icon
                  :icon="priorityIcon(n.priority)"
                  class="w-4 h-4"
                />
              </div>
            </div>
            <div class="card-body">
              <div class="card-header">
                <span class="card-title">{{ n.title }}</span>
                <span
                  v-if="!n.read"
                  class="unread-dot"
                />
              </div>
              <p class="card-desc">
                {{ n.body }}
              </p>
              <div class="card-meta">
                <span class="meta-agent">
                  <Icon
                    icon="lucide:bot"
                    class="w-3 h-3"
                  />
                  {{ agentDefs.get(n.agentId)?.name || "Agent" }}
                </span>
                <span class="meta-time">
                  <Icon
                    icon="lucide:clock"
                    class="w-3 h-3"
                  />
                  {{ formatTime(notificationTime(n)) }}
                </span>
                <span
                  v-if="n.conversationId"
                  class="meta-conversation"
                >
                  <Icon
                    icon="lucide:message-square"
                    class="w-3 h-3"
                  />
                  Open chat
                </span>
              </div>
            </div>
            <button
              type="button"
              class="card-dismiss"
              title="Dismiss"
              :aria-label="`Dismiss ${n.title}`"
              @click.stop="notificationStore.remove(n.id)"
            >
              <Icon
                icon="lucide:x"
                class="w-3.5 h-3.5"
              />
            </button>
          </div>
        </div>
      </div>
    </div>

    <ModalDialog
      :show="showClearConfirm"
      title="Clear all notifications?"
      icon="lucide:trash-2"
      icon-color="red"
      @close="showClearConfirm = false"
    >
      <p class="text-sm leading-relaxed text-ink-secondary">
        All {{ notificationStore.notifications.length }} notifications will be deleted. This cannot be undone.
      </p>
      <p
        v-if="clearError"
        class="mt-3 rounded-lg border border-red-400/25 bg-red-400/10 px-3 py-2 text-xs text-status-danger"
        role="alert"
      >
        {{ clearError }}
      </p>
      <template #actions>
        <button
          type="button"
          class="w-full rounded-xl bg-red-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-red-500 disabled:cursor-wait disabled:opacity-60"
          :disabled="clearing"
          @click="clearAll"
        >
          {{ clearing ? "Clearing…" : "Clear notifications" }}
        </button>
        <button
          type="button"
          class="w-full rounded-xl bg-theme-800 px-4 py-3 text-sm font-medium text-theme-200 transition hover:bg-theme-700"
          :disabled="clearing"
          @click="showClearConfirm = false"
        >
          Cancel
        </button>
      </template>
    </ModalDialog>
  </div>
</template>

<style scoped>
.notifications-view {
  display: flex;
  flex-direction: column;
  width: 100%;
}

/* ── Empty state ── */
.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  color: var(--color-theme-500, #71717a);
}

.empty-icon {
  width: 3rem;
  height: 3rem;
  margin-bottom: 0.5rem;
  opacity: 0.5;
}

.empty-title {
  font-size: 1.125rem;
  font-weight: 600;
  color: var(--color-theme-300, #d4d4d8);
  margin: 0;
}

.empty-desc {
  font-size: 0.8125rem;
  color: var(--color-theme-500, #71717a);
  margin: 0;
}

/* ── Group ── */
.notification-group {
  margin-bottom: 1.5rem;
}

.group-header {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  margin-bottom: 0.75rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--color-theme-800, #27272a);
}

.group-label {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--color-theme-300, #d4d4d8);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.group-count {
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--color-theme-600, #52525b);
  background: var(--color-theme-800, #27272a);
  border-radius: 999px;
  padding: 0.0625rem 0.4375rem;
  line-height: 1.25rem;
}

/* ── Grid ── */
.notification-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 0.75rem;
}

/* ── Card ── */
.notification-card {
  display: flex;
  gap: 0.75rem;
  padding: 1rem;
  border-radius: 0.75rem;
  background: var(--color-theme-900, #18181b);
  border: 1px solid var(--color-theme-800, #27272a);
  cursor: pointer;
  transition: all 150ms ease;
  position: relative;
}

.notification-card:hover {
  background: var(--color-theme-850, #1c1c1f);
  border-color: var(--color-theme-700, #3f3f46);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}

.notification-card.unread {
  border-left: 3px solid var(--color-accent-500, #3b82f6);
  background: var(--color-theme-900, #18181b);
}

.notification-card.priority-alert {
  border-left-color: var(--color-red-500, #ef4444);
}

.notification-card.priority-action {
  border-left-color: var(--color-amber-500, #f59e0b);
}

.card-left {
  flex-shrink: 0;
}

.priority-icon {
  width: 2rem;
  height: 2rem;
  border-radius: 0.5rem;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-theme-800, #27272a);
}

.priority-alert .priority-icon {
  color: var(--color-red-400, #f87171);
  background: color-mix(in srgb, var(--color-red-500, #ef4444) 12%, transparent);
}

.priority-action .priority-icon {
  color: var(--color-amber-400, #fbbf24);
  background: color-mix(in srgb, var(--color-amber-500, #f59e0b) 12%, transparent);
}

.priority-notice .priority-icon {
  color: var(--color-accent-400, #60a5fa);
  background: color-mix(in srgb, var(--color-accent-500, #3b82f6) 12%, transparent);
}

/* ── Body ── */
.card-body {
  flex: 1;
  min-width: 0;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.25rem;
}

.card-title {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--color-theme-200, #e4e4e7);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.unread-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--color-accent-500, #3b82f6);
  flex-shrink: 0;
}

.card-desc {
  font-size: 0.8125rem;
  color: var(--color-theme-400, #a1a1aa);
  margin: 0 0 0.5rem;
  line-height: 1.4;
  display: -webkit-box;
  line-clamp: 5;
  -webkit-line-clamp: 5;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.card-meta {
  display: flex;
  align-items: center;
  gap: 1rem;
  font-size: 0.6875rem;
  color: var(--color-theme-500, #71717a);
}

.card-meta svg {
  flex-shrink: 0;
}

.meta-agent,
.meta-time,
.meta-conversation {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}

.meta-conversation {
  color: var(--color-accent-500, #3b82f6);
}

/* ── Dismiss ── */
.card-dismiss {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  width: 1.5rem;
  height: 1.5rem;
  border: none;
  border-radius: 0.375rem;
  background: transparent;
  color: var(--color-theme-600, #52525b);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: all 150ms ease;
}

.notification-card:hover .card-dismiss {
  opacity: 1;
}

.card-dismiss:hover {
  background: var(--color-theme-700, #3f3f46);
  color: var(--color-theme-300, #d4d4d8);
}

/* ── Responsive ── */
@media (max-width: 640px) {
  .notification-grid {
    grid-template-columns: 1fr;
  }
}
</style>
