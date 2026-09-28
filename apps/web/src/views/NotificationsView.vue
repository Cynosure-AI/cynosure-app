<script setup lang="ts">
import { onMounted } from "vue";
import { useRouter } from "vue-router";
import { useNotificationStore } from "../stores/notification.store";
import { useAgentDefinitionsStore } from "../stores/agent-definitions.store";
import { useChatStore } from "../stores/chat.store";
import { Icon } from "@iconify/vue";

const router = useRouter();
const notificationStore = useNotificationStore();
const agentDefs = useAgentDefinitionsStore();
const chatStore = useChatStore();

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
  <div class="notifications-view">
    <!-- Header -->
    <header class="view-header">
      <div class="header-left">
        <h1 class="view-title">
          Notifications
        </h1>
        <span class="view-subtitle">
          {{ notificationStore.notifications.length }} total
        </span>
      </div>
      <div class="header-actions">
        <button
          v-if="notificationStore.unreadCount > 0"
          class="btn btn-ghost btn-sm"
          @click="notificationStore.markAllRead()"
        >
          <Icon
            icon="lucide:check-check"
            class="w-4 h-4"
          />
          Mark all read
        </button>
        <button
          v-if="notificationStore.notifications.length > 0"
          class="btn btn-ghost btn-sm text-ink-muted hover:text-status-danger"
          @click="notificationStore.removeAll()"
        >
          <Icon
            icon="lucide:trash-2"
            class="w-4 h-4"
          />
          Clear notifications
        </button>
      </div>
    </header>

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
</template>

<style scoped>
.notifications-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  max-width: 80rem;
  margin-inline: auto;
  padding: 1.5rem 2rem;
  width: 100%;
  overflow-y: auto;
}

/* ── Header ── */
.view-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.5rem;
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
}

.view-title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--color-theme-100, #f4f4f5);
  margin: 0;
}

.view-subtitle {
  font-size: 0.8125rem;
  color: var(--color-theme-500, #71717a);
}

.header-actions {
  display: flex;
  gap: 0.5rem;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  border: none;
  border-radius: 0.5rem;
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 150ms ease;
}

.btn-ghost {
  background: transparent;
  color: var(--color-theme-400, #a1a1aa);
  padding: 0.375rem 0.75rem;
}

.btn-ghost:hover {
  background: var(--color-theme-800, #27272a);
  color: var(--color-theme-200, #e4e4e7);
}

.btn-sm {
  padding: 0.375rem 0.625rem;
  font-size: 0.75rem;
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
  .notifications-view {
    padding: 1rem;
  }

  .view-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.75rem;
  }

  .notification-grid {
    grid-template-columns: 1fr;
  }
}
</style>
