<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { storeToRefs } from "pinia";
import { useRoute, useRouter } from "vue-router";
import { useProviderStore } from "../../stores/provider.store";
import { useNotificationStore } from "../../stores/notification.store";
import { useAgentDefinitionsStore } from "../../stores/agent-definitions.store";
import { useChatStore } from "../../stores/chat.store";
import { useMemoryJobsStore } from "../../stores/memory-jobs.store";
import { usePreferencesStore } from "../../stores/preferences.store";
import { api } from "../../api/client";
import { wsConnected } from "../../api/http";
import type { AgentInstance } from "../../api/types";
import { Icon } from "@iconify/vue";
import { useSidebar } from "../../composables/useSidebar";
import { useAppBranding } from "../../composables/useAppBranding";
import WorkspacePopover from "../status/WorkspacePopover.vue";
import HoverTooltip from "../shared/HoverTooltip.vue";
import GlobalRecentChats from "./GlobalRecentChats.vue";

const route = useRoute();
const router = useRouter();
const providerStore = useProviderStore();
const notificationStore = useNotificationStore();
const agentDefs = useAgentDefinitionsStore();
const chatStore = useChatStore();
const memoryJobsStore = useMemoryJobsStore();
const preferencesStore = usePreferencesStore();
const { recentChatFilter } = storeToRefs(preferencesStore);
const { close: closeSidebar, sidebarCollapsed, toggleCollapse } = useSidebar();
const { logoIconUrl, logoTextUrl } = useAppBranding();

const showStatusPopover = ref(false);
const statusButtonRef = ref<HTMLElement | null>(null);
const showNotifications = ref(false);
const workspaceOpen = ref(true);
const recentChatsOpen = ref(true);
const recentFilterMenuOpen = ref(false);
const bellBtnRef = ref<HTMLElement | null>(null);
const notifPopoverStyle = computed(() => {
  if (!bellBtnRef.value) return {};
  const rect = bellBtnRef.value.getBoundingClientRect();
  return {
    position: "fixed" as const,
    top: `${rect.bottom + 8}px`,
    left: `${rect.left}px`,
  };
});

const instances = ref<AgentInstance[]>([]);
let instancePollTimer: ReturnType<typeof setInterval> | undefined;
let unsubHITLRequest: (() => void) | undefined;
let unsubExecutionUpdate: (() => void) | undefined;

const hasAwaitingApproval = computed(() =>
  instances.value.some((i) => i.status === "awaiting-approval"),
);
const activeWorkCount = computed(() => instances.value.length + memoryJobsStore.activeJobs.length);
const runningConversationIds = computed(() => instances.value
  .filter((instance) => instance.status === "running" && instance.conversationId)
  .map((instance) => instance.conversationId as string));
const awaitingConversationIds = computed(() => instances.value
  .filter((instance) => instance.status === "awaiting-approval" && instance.conversationId)
  .map((instance) => instance.conversationId as string));

async function loadInstances() {
  try {
    instances.value = await api.instances.list();
  } catch {
    // silently ignore
  }
}

onMounted(() => {
  loadInstances();
  memoryJobsStore.startPolling();
  instancePollTimer = setInterval(loadInstances, 1_500);
  unsubHITLRequest = api.agent.onHITLRequest(() => {
    loadInstances();
  });
  unsubExecutionUpdate = api.agent.onExecutionUpdate((data: unknown) => {
    const d = data as { event?: string; data?: { status?: string } };
    if (d.event === "step:status" && d.data?.status !== "awaiting-approval")
      loadInstances();
  });
  document.addEventListener("click", closeRecentFilterMenu);
});

onUnmounted(() => {
  clearInterval(instancePollTimer);
  memoryJobsStore.stopPolling();
  unsubHITLRequest?.();
  unsubExecutionUpdate?.();
  document.removeEventListener("click", closeRecentFilterMenu);
});

function closeRecentFilterMenu(): void {
  recentFilterMenuOpen.value = false;
}

function setRecentChatFilter(filter: "all" | "agent"): void {
  recentChatFilter.value = filter;
  recentFilterMenuOpen.value = false;
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const future = diff < 0;
  const absDiff = Math.abs(diff);
  const mins = Math.floor(absDiff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return future ? `in ${mins}m` : `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return future ? `in ${hrs}h` : `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return future ? `in ${days}d` : `${days}d ago`;
}

function notificationTime(notif: { createdAt: number }): number {
  return notif.createdAt;
}

function notificationPriorityIcon(priority: string): string {
  switch (priority) {
    case "alert":
      return "lucide:alert-triangle";
    case "action":
      return "lucide:circle-alert";
    default:
      return "lucide:info";
  }
}

async function navigateToNotification(notif: {
  id: string;
  agentId: string;
  conversationId: string | null;
}) {
  notificationStore.markRead(notif.id);
  showNotifications.value = false;
  closeSidebar();
  if (notif.conversationId) {
    await chatStore.setActiveAgent(notif.agentId || null);
    await chatStore.selectConversation(notif.conversationId);
    router.push(`/chat/${encodeURIComponent(notif.conversationId)}`);
  } else if (notif.agentId) {
    router.push(`/agents/${notif.agentId}`);
  }
}

function isActive(path: string, exact = false): boolean {
  if (exact) return route.path === path;
  return route.path === path || route.path.startsWith(path + "/");
}

const chatRoute = computed(() =>
  chatStore.activeConversationId
    ? `/chat/${encodeURIComponent(chatStore.activeConversationId)}`
    : "/chat",
);
</script>

<template>
  <aside
    class="bg-theme-950 relative flex flex-col h-full shrink-0 transition-all duration-200 overflow-hidden"
    :class="sidebarCollapsed ? 'w-72 md:w-16 sidebar-collapsed' : 'w-72'"
  >
    <!-- Brand -->
    <div class="brand-area pl-3 pr-2 py-3 mt-2 mb-2 flex items-center gap-3 shrink-0">
      <div class="brand-logo-glitch-wrap">
        <div
          class="brand-logo-glitch"
          aria-label="Cynosure"
        >
          <div class="brand-logo-layer brand-logo-base">
            <img
              :src="logoIconUrl"
              alt=""
              class="brand-logo-icon w-8 h-8 object-contain"
            >
            <img
              :src="logoTextUrl"
              alt="Cynosure"
              class="brand-logo-text h-8 w-auto max-w-36 object-contain flex-1"
            >
          </div>

          <div
            class="brand-logo-layer brand-logo-copy brand-logo-copy-a"
            aria-hidden="true"
          >
            <img
              :src="logoIconUrl"
              alt=""
              class="brand-logo-icon w-8 h-8 object-contain"
            >
            <img
              :src="logoTextUrl"
              alt=""
              class="brand-logo-text h-8 w-auto max-w-36 object-contain flex-1"
            >
          </div>

          <div
            class="brand-logo-layer brand-logo-copy brand-logo-copy-b"
            aria-hidden="true"
          >
            <img
              :src="logoIconUrl"
              alt=""
              class="brand-logo-icon w-8 h-8 object-contain"
            >
            <img
              :src="logoTextUrl"
              alt=""
              class="brand-logo-text h-8 w-auto max-w-36 object-contain flex-1"
            >
          </div>
        </div>
      </div>

      <!-- Header actions -->
      <div class="brand-actions flex items-center gap-1 shrink-0">
        <!-- Notification Bell -->
        <div class="relative">
          <button
            ref="bellBtnRef"
            type="button"
            class="p-1.5 rounded-lg hover:bg-theme-800 transition-colors relative"
            aria-label="Open notifications"
            aria-haspopup="dialog"
            :aria-expanded="showNotifications"
            @click.stop="showNotifications = !showNotifications"
          >
            <Icon
              icon="lucide:bell"
              class="w-4 h-4"
              :class="notificationStore.unreadCount > 0
                ? 'text-accent-400'
                : 'text-theme-500'
              "
            />
            <span
              v-if="notificationStore.unreadCount > 0"
              class="absolute -top-0.5 -right-0.5 w-4 h-4 bg-red-500 rounded-full text-[9px] font-bold text-white flex items-center justify-center leading-none"
            >
              {{
                notificationStore.unreadCount > 9
                  ? "9+"
                  : notificationStore.unreadCount
              }}
            </span>
          </button>

          <Teleport to="body">
            <!-- Notification Popover -->
            <Transition
              enter-active-class="transition duration-150 ease-out"
              enter-from-class="opacity-0 -translate-y-2"
              enter-to-class="opacity-100 translate-y-0"
              leave-active-class="transition duration-100 ease-in"
              leave-from-class="opacity-100 translate-y-0"
              leave-to-class="opacity-0 -translate-y-2"
            >
              <div
                v-if="showNotifications"
                role="dialog"
                aria-label="Notifications"
                class="w-80 bg-theme-900 border border-theme-700 rounded-xl shadow-2xl overflow-hidden z-200"
                :style="notifPopoverStyle"
                @click.stop
              >
                <!-- Header -->
                <div class="flex items-center justify-between px-3 py-2.5 border-b border-theme-800">
                  <span class="text-xs font-semibold text-theme-200">Notifications</span>
                  <div class="flex items-center gap-1">
                    <RouterLink
                      to="/notifications"
                      class="text-[10px] text-accent-400 hover:text-accent-300 transition-colors px-1.5 py-0.5"
                      @click="showNotifications = false"
                    >
                      View all
                    </RouterLink>
                    <button
                      v-if="notificationStore.unreadCount > 0"
                      class="text-[10px] text-accent-400 hover:text-accent-300 transition-colors px-1.5 py-0.5"
                      @click.stop="notificationStore.markAllRead()"
                    >
                      Mark all read
                    </button>
                    <button
                      v-if="notificationStore.notifications.length > 0"
                      class="text-[10px] text-theme-500 hover:text-theme-300 transition-colors px-1.5 py-0.5"
                      @click.stop="notificationStore.removeAll()"
                    >
                      Clear all
                    </button>
                  </div>
                </div>

                <!-- Notifications list -->
                <div class="max-h-72 overflow-y-auto">
                  <div
                    v-if="notificationStore.notifications.length === 0"
                    class="px-3 py-6 text-center text-xs text-theme-500"
                  >
                    No notifications yet
                  </div>
                  <div
                    v-for="notif in notificationStore.notifications"
                    :key="notif.id"
                    role="button"
                    tabindex="0"
                    class="w-full text-left px-3 py-2.5 hover:bg-theme-800/60 transition-colors border-b border-theme-800/50 last:border-0 flex gap-2.5 cursor-pointer"
                    :class="{ 'bg-theme-800/30': !notif.read }"
                    @click="navigateToNotification(notif)"
                    @keydown.enter.prevent="navigateToNotification(notif)"
                    @keydown.space.prevent="navigateToNotification(notif)"
                  >
                    <!-- Priority indicator -->
                    <div class="mt-1 shrink-0">
                      <Icon
                        :icon="notificationPriorityIcon(notif.priority)"
                        class="w-3.5 h-3.5"
                        :class="{
                          'text-red-400': notif.priority === 'alert',
                          'text-amber-400': notif.priority === 'action',
                          'text-accent-400': notif.priority === 'notice',
                        }"
                      />
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-1.5">
                        <span
                          v-if="!notif.read"
                          class="w-1.5 h-1.5 rounded-full bg-accent-500 shrink-0"
                        />
                        <span class="text-xs font-medium text-theme-200 truncate">{{ notif.title }}</span>
                      </div>
                      <p class="text-[11px] text-theme-500 mt-0.5 line-clamp-2">
                        {{ notif.body }}
                      </p>
                      <div class="flex items-center gap-2 mt-1">
                        <span class="text-[10px] text-theme-600">
                          {{ agentDefs.get(notif.agentId)?.name || "Agent" }}
                        </span>
                        <span class="text-[10px] text-theme-600">·</span>
                        <span class="text-[10px] text-theme-600">{{
                          formatTimeAgo(notificationTime(notif))
                        }}</span>
                      </div>
                    </div>
                    <!-- Delete button -->
                    <button
                      type="button"
                      class="mt-1 shrink-0 text-theme-600 hover:text-theme-300 transition-colors"
                      :aria-label="`Dismiss ${notif.title}`"
                      @click.stop="notificationStore.remove(notif.id)"
                    >
                      <Icon
                        icon="lucide:x"
                        class="w-3 h-3"
                      />
                    </button>
                  </div>
                </div>
              </div>
            </Transition>

            <!-- Click-outside backdrop -->
            <div
              v-if="showNotifications"
              class="fixed inset-0 z-199"
              @click="showNotifications = false"
            />
          </Teleport>
        </div>

        <!-- Collapse toggle (desktop only) -->
        <button
          type="button"
          class="collapse-toggle-btn hidden md:flex p-1.5 rounded-lg text-theme-500 hover:text-theme-300 hover:bg-theme-800 transition-colors"
          :title="sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
          :aria-label="sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
          :aria-expanded="!sidebarCollapsed"
          @click="toggleCollapse"
        >
          <Icon
            icon="lucide:menu"
            class="w-4 h-4"
          />
        </button>
      </div>
    </div>

    <!-- V2 Navigation -->
    <nav class="flex min-h-0 flex-1 flex-col overflow-hidden px-3 pb-1">
      <!-- Chat -->
      <HoverTooltip
        placement="right"
        block
        :disabled="!sidebarCollapsed"
      >
        <RouterLink
          :to="chatRoute"
          class="nav-item"
          :class="{ active: isActive('/chat') }"
        >
          <Icon
            icon="lucide:message-square"
            class="w-4.5 h-4.5"
          />
          <span>Chat</span>
        </RouterLink>
        <template #content>
          Chat
        </template>
      </HoverTooltip>

      <div class="section-separator" />

      <section class="sidebar-region shrink-0">
        <button
          type="button"
          class="region-toggle"
          :aria-expanded="workspaceOpen"
          @click="workspaceOpen = !workspaceOpen"
        >
          <span>Workspace</span>
          <Icon
            icon="lucide:chevron-down"
            class="h-3.5 w-3.5 transition-transform"
            :class="{ '-rotate-90': !workspaceOpen }"
          />
        </button>
        <div
          v-show="workspaceOpen || sidebarCollapsed"
          class="space-y-0.5"
        >
          <HoverTooltip
            v-for="item in [
              { to: '/cron', icon: 'lucide:calendar-clock', label: 'Schedule' },
              { to: '/agents', icon: 'lucide:bot', label: 'Agents' },
              { to: '/artifacts', icon: 'lucide:shapes', label: 'Artifacts' },
              { to: '/memory-spaces', icon: 'lucide:brain', label: 'Memories' },
            ]"
            :key="item.to"
            placement="right"
            block
            :disabled="!sidebarCollapsed"
          >
            <RouterLink
              :to="item.to"
              class="nav-item"
              :class="{ active: isActive(item.to) }"
            >
              <Icon
                :icon="item.icon"
                class="h-4.5 w-4.5"
              />
              <span>{{ item.label }}</span>
            </RouterLink>
            <template #content>
              {{ item.label }}
            </template>
          </HoverTooltip>
        </div>
      </section>

      <section class="recent-region flex min-h-0 flex-1 flex-col">
        <div class="section-separator" />
        <div class="group/recent-header relative flex items-center">
          <button
            type="button"
            class="region-toggle min-w-0 flex-1 pr-1"
            :aria-expanded="recentChatsOpen"
            @click="recentChatsOpen = !recentChatsOpen"
          >
            <span>Recent chats</span>
            <Icon
              icon="lucide:chevron-down"
              class="h-3.5 w-3.5 transition-transform"
              :class="{ '-rotate-90': !recentChatsOpen }"
            />
          </button>
          <button
            type="button"
            class="absolute right-8 z-10 flex h-6 w-6 items-center justify-center rounded-md text-theme-500 opacity-0 transition hover:bg-theme-800 hover:text-theme-200 group-hover/recent-header:opacity-100 focus-visible:opacity-100"
            :class="{ 'bg-theme-800 text-theme-200 opacity-100': recentFilterMenuOpen }"
            aria-label="Filter recent chats"
            aria-haspopup="menu"
            :aria-expanded="recentFilterMenuOpen"
            @click.stop="recentFilterMenuOpen = !recentFilterMenuOpen"
          >
            <Icon
              icon="lucide:ellipsis"
              class="h-4 w-4"
            />
          </button>
          <div
            v-if="recentFilterMenuOpen"
            role="menu"
            class="absolute right-2 top-7 z-30 w-44 overflow-hidden rounded-lg border border-theme-700 bg-theme-900 py-1 shadow-xl"
            @click.stop
          >
            <div
              class="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-theme-500"
            >
              Sort By
            </div>

            <button
              type="button"
              role="menuitemradio"
              :aria-checked="recentChatFilter === 'all'"
              class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800"
              @click="setRecentChatFilter('all')"
            >
              <Icon
                icon="lucide:messages-square"
                class="h-3.5 w-3.5 text-theme-500"
              />
              <span class="flex-1">All Recent</span>
              <Icon
                v-if="recentChatFilter === 'all'"
                icon="lucide:check"
                class="h-3.5 w-3.5 text-accent-400"
              />
            </button>

            <button
              type="button"
              role="menuitemradio"
              :aria-checked="recentChatFilter === 'agent'"
              class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800"
              :title="chatStore.activeAgentId ? 'Show chats for the active agent' : 'Show Free Chat conversations'"
              @click="setRecentChatFilter('agent')"
            >
              <Icon
                :icon="chatStore.activeAgentId ? 'lucide:bot' : 'lucide:message-square'"
                class="h-3.5 w-3.5 text-theme-500"
              />
              <span class="flex-1">Selected Agent</span>
              <Icon
                v-if="recentChatFilter === 'agent'"
                icon="lucide:check"
                class="h-3.5 w-3.5 text-accent-400"
              />
            </button>
          </div>
        </div>
        <GlobalRecentChats
          v-if="recentChatsOpen && !sidebarCollapsed"
          :awaiting-conversation-ids="awaitingConversationIds"
          :active-conversation-ids="runningConversationIds"
          :agent-id="recentChatFilter === 'agent' ? chatStore.activeAgentId : undefined"
        />
      </section>
    </nav>

    <!-- Status Footer -->
    <div class="status-section px-3 py-3 shrink-0 relative">
      <button
        ref="statusButtonRef"
        class="status-trigger w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-theme-800/60 transition-colors text-left"
        :aria-expanded="showStatusPopover"
        @click="showStatusPopover = !showStatusPopover"
      >
        <span class="relative flex h-8 w-8 shrink-0 items-center justify-center overflow-visible rounded-full bg-theme-800 ring-1 ring-theme-700/70">
          <img
            v-if="preferencesStore.userAvatarUrl"
            :src="preferencesStore.userAvatarUrl"
            alt=""
            class="h-full w-full rounded-full object-cover"
          >
          <Icon
            v-else
            icon="lucide:user-round"
            class="h-4 w-4 text-theme-500"
          />
          <span
            class="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-theme-950"
            :class="{
              'bg-red-500 animate-pulse': !wsConnected,
              'bg-amber-500 animate-pulse': wsConnected && hasAwaitingApproval,
              'bg-accent-500 animate-pulse':
                wsConnected &&
                !hasAwaitingApproval &&
                (instances.length > 0 || memoryJobsStore.hasRunningJobs),
              'bg-emerald-500':
                wsConnected &&
                instances.length === 0 &&
                !memoryJobsStore.hasRunningJobs &&
                providerStore.providers.length > 0,
              'bg-theme-600': wsConnected && !memoryJobsStore.hasRunningJobs && !providerStore.providers.length,
            }"
          />
        </span>
        <span class="flex min-w-0 flex-1 flex-col">
          <span
            v-if="preferencesStore.userName.trim()"
            class="truncate text-sm font-semibold leading-5 text-theme-200"
          >
            {{ preferencesStore.userName.trim() }}
          </span>
          <span class="truncate text-[11px] leading-4 text-theme-400">
            <template v-if="!wsConnected">Connecting...</template>
            <template v-else-if="hasAwaitingApproval">Needs Attention</template>
            <template v-else-if="instances.length > 0">Agents Running...</template>
            <template v-else-if="memoryJobsStore.hasRunningJobs">{{ memoryJobsStore.statusLabel }}</template>
            <template v-else-if="!providerStore.providers.length">No providers</template>
            <template v-else>Ready</template>
          </span>
        </span>
        <Icon
          icon="lucide:settings"
          class="h-4 w-4 shrink-0 text-theme-500 transition-colors"
          :class="{ 'text-accent-400': showStatusPopover }"
        />
      </button>

      <!-- Workspace Popover -->
      <WorkspacePopover
        :show="showStatusPopover"
        :anchor-el="statusButtonRef"
        :active-work-count="activeWorkCount"
        :has-awaiting-approval="hasAwaitingApproval"
        @close="showStatusPopover = false"
      />
    </div>

    <!-- Click-away overlay -->
    <Teleport to="body">
      <div
        v-if="showStatusPopover"
        class="fixed inset-0 z-40"
        @click="showStatusPopover = false"
      />
      <div
        v-if="showNotifications"
        class="fixed inset-0 z-40"
        @click="showNotifications = false"
      />
    </Teleport>
  </aside>
</template>

<style scoped>
.nav-item {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.5rem 0.75rem;
  border-radius: 0.5rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--color-theme-400, #a1a1aa);
  cursor: pointer;
  margin-bottom: 2px;
  transition: all 150ms ease;
  width: 100%;
}

.nav-item:hover {
  color: var(--color-theme-100, #f4f4f5);
  background-color: var(--color-theme-800, #27272a);
}

.nav-item.active {
  color: var(--color-theme-100, #f4f4f5);
  background-color: var(--color-theme-800, #27272a);
  box-shadow: inset 3px 0 0 var(--color-accent-500, #3b82f6);
}

.section-label {
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--color-theme-500, #71717a);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 1.25rem 0.75rem 0.5rem;
}

.section-separator {
  height: 1px;
  margin: 0.5rem 0.75rem 0;
  background-color: var(--color-theme-800, #27272a);
  opacity: 0.6;
}

.region-toggle {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  padding: 0.65rem 0.75rem 0.4rem;
  color: var(--color-theme-500, #71717a);
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  transition: color 150ms ease;
}

.region-toggle:hover {
  color: var(--color-theme-300, #d4d4d8);
}

.brand-logo-icon {
  display: none;
}

.collapsed-hitl-indicator {
  display: none;
}

/* ── Collapsed sidebar (desktop only) ── */
@media (min-width: 768px) {
  .sidebar-collapsed nav {
    padding-inline: 0.5rem;
    overflow-x: hidden;
    scrollbar-width: thin;
  }

  .sidebar-collapsed nav::-webkit-scrollbar {
    width: 0.375rem;
  }

  .sidebar-collapsed .nav-item {
    justify-content: center;
    gap: 0;
    width: 2.5rem;
    min-height: 2.25rem;
    padding: 0.5rem;
    margin-inline: auto;
  }

  .sidebar-collapsed .nav-item> :first-child {
    width: 1.125rem;
    min-width: 1.125rem;
    height: 1.125rem;
    flex-shrink: 0;
  }

  .sidebar-collapsed .nav-item>*:not(:first-child) {
    display: none;
  }

  .sidebar-collapsed .collapsed-hitl-indicator {
    display: flex;
  }

  .sidebar-collapsed .section-label {
    display: none;
  }

  .sidebar-collapsed .section-separator {
    margin: 0.375rem auto 0.375rem;
    width: 60%;
    opacity: 1;
  }

  .sidebar-collapsed .region-toggle,
  .sidebar-collapsed .recent-region {
    display: none;
  }

  .sidebar-collapsed .sidebar-region {
    margin-top: 0.25rem;
  }

  .sidebar-collapsed .brand-area {
    flex-direction: column;
    justify-content: center;
    align-items: center;
    padding-inline: 0;
    gap: 0.5rem;
  }

  .sidebar-collapsed .brand-area>*:not(:first-child):not(.brand-actions) {
    display: none;
  }

  .sidebar-collapsed .brand-logo-glitch-wrap {
    flex: none;
    padding-left: 0;
  }

  .sidebar-collapsed .brand-logo-icon {
    display: block;
  }

  .sidebar-collapsed .brand-logo-text {
    display: none;
  }

  .sidebar-collapsed .brand-actions {
    flex: none;
    width: 100%;
    justify-content: center;
  }

  .sidebar-collapsed .brand-actions .relative {
    display: none;
  }

  .sidebar-collapsed .status-section>.status-trigger {
    justify-content: center;
    gap: 0;
    padding: 0.5rem;
  }

  .sidebar-collapsed .status-section>.status-trigger>*:not(:first-child) {
    display: none;
  }
}

/* ── Logo glitch effect ── */
.brand-logo-glitch-wrap {
  flex: 1;
  min-width: 0;
  padding-left: 0.25rem;
}

.brand-logo-glitch {
  position: relative;
  display: flex;
  align-items: center;
  width: fit-content;
  max-width: 100%;
  height: 2rem;
}

.brand-logo-layer {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
}

.brand-logo-base {
  position: relative;
  z-index: 2;
}

.brand-logo-copy {
  position: absolute;
  inset: 0;
  z-index: 3;
  opacity: 0;
  pointer-events: none;
}

.brand-logo-glitch:hover .brand-logo-base {
  animation: logo-glitch-base 700ms steps(2, jump-none) 1;
}

.brand-logo-glitch:hover .brand-logo-copy-a {
  animation: logo-glitch-a 700ms steps(2, jump-none) 1;
}

.brand-logo-glitch:hover .brand-logo-copy-b {
  animation: logo-glitch-b 700ms steps(2, jump-none) 1;
}

@keyframes logo-glitch-base {
  0% {
    transform: translate(0, 0);
  }
  16% {
    transform: translate(-1px, 0);
  }
  32% {
    transform: translate(1px, 0);
  }
  48%,
  100% {
    transform: translate(0, 0);
  }
}

@keyframes logo-glitch-a {
  0% {
    opacity: 0;
    clip-path: polygon(0 0, 0 0, 0 0, 0 0);
    transform: translate(0, 0);
  }
  8% {
    opacity: 0.8;
    clip-path: polygon(0 6%, 100% 6%, 100% 18%, 0 18%);
    transform: translate(3px, 0);
  }
  18% {
    opacity: 0.75;
    clip-path: polygon(0 58%, 100% 58%, 100% 72%, 0 72%);
    transform: translate(-3px, 0);
  }
  28% {
    opacity: 0.65;
    clip-path: polygon(0 34%, 100% 34%, 100% 46%, 0 46%);
    transform: translate(2px, 0);
  }
  40%,
  100% {
    opacity: 0;
    clip-path: polygon(0 0, 0 0, 0 0, 0 0);
    transform: translate(0, 0);
  }
}

@keyframes logo-glitch-b {
  0% {
    opacity: 0;
    clip-path: polygon(0 0, 0 0, 0 0, 0 0);
    transform: translate(0, 0);
  }
  10% {
    opacity: 0.55;
    clip-path: polygon(0 72%, 100% 72%, 100% 86%, 0 86%);
    transform: translate(-2px, 0);
  }
  20% {
    opacity: 0.5;
    clip-path: polygon(0 18%, 100% 18%, 100% 28%, 0 28%);
    transform: translate(2px, 0);
  }
  30% {
    opacity: 0.45;
    clip-path: polygon(0 48%, 100% 48%, 100% 60%, 0 60%);
    transform: translate(-3px, 0);
  }
  42%,
  100% {
    opacity: 0;
    clip-path: polygon(0 0, 0 0, 0 0, 0 0);
    transform: translate(0, 0);
  }
}
</style>
