<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useProviderStore } from "../../stores/provider.store";
import { useNotificationStore } from "../../stores/notification.store";
import { useAgentDefinitionsStore } from "../../stores/agent-definitions.store";
import { useChatStore } from "../../stores/chat.store";
import { useMemoryJobsStore } from "../../stores/memory-jobs.store";
import { api } from "../../api/client";
import { wsConnected } from "../../api/http";
import type { AgentInstance } from "../../api/types";
import { Icon } from "@iconify/vue";
import { useSidebar } from "../../composables/useSidebar";
import { useAppBranding } from "../../composables/useAppBranding";
import StatusPopover from "../status/StatusPopover.vue";
import HoverTooltip from "../shared/HoverTooltip.vue";

const route = useRoute();
const router = useRouter();
const providerStore = useProviderStore();
const notificationStore = useNotificationStore();
const agentDefs = useAgentDefinitionsStore();
const chatStore = useChatStore();
const memoryJobsStore = useMemoryJobsStore();
const { close: closeSidebar, sidebarCollapsed, toggleCollapse } = useSidebar();
const { logoIconUrl, logoTextUrl } = useAppBranding();

const showStatusPopover = ref(false);
const statusButtonRef = ref<HTMLElement | null>(null);
const showNotifications = ref(false);
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
});

onUnmounted(() => {
  clearInterval(instancePollTimer);
  memoryJobsStore.stopPolling();
  unsubHITLRequest?.();
  unsubExecutionUpdate?.();
});

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
    router.push(`/triggers/chat/${notif.conversationId}`);
  } else if (notif.agentId) {
    router.push(`/agents/${notif.agentId}`);
  }
}

function isActive(path: string, exact = false): boolean {
  if (exact) return route.path === path;
  return route.path === path || route.path.startsWith(path + "/");
}

interface NavItem {
  to: string;
  icon: string;
  label: string;
  badge?: string;
  exact?: boolean;
}

const triggerItems: NavItem[] = [
  { to: "/triggers/cron", icon: "lucide:clock", label: "Cron" },
];

const settingsItems: NavItem[] = [
  { to: "/settings", icon: "lucide:settings", label: "Settings", exact: true },
  { to: "/settings/mcp", icon: "lucide:plug", label: "MCP Servers" },
  { to: "/tools-policy", icon: "lucide:wrench", label: "Tools Policy" },
];

const chatRoute = computed(() =>
  chatStore.activeConversationId
    ? `/triggers/chat/${chatStore.activeConversationId}`
    : "/chat",
);
</script>

<template>
  <aside
    class="bg-theme-950 relative flex flex-col h-full shrink-0 transition-all duration-200 overflow-hidden"
    :class="sidebarCollapsed ? 'w-60 md:w-16 sidebar-collapsed' : 'w-60'"
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

    <!-- Navigation -->
    <nav class="flex-1 overflow-y-auto py-2 px-3">
      <!-- Chat -->
      <HoverTooltip
        placement="right"
        block
        :disabled="!sidebarCollapsed"
      >
        <RouterLink
          :to="chatRoute"
          class="nav-item"
          :class="{ active: isActive('/triggers/chat') }"
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



      <!-- Triggers -->
      <div class="section-separator" />
      <div class="section-label">
        Triggers
      </div>
      <HoverTooltip
        v-for="item in triggerItems"
        :key="item.to"
        placement="right"
        block
        :disabled="!sidebarCollapsed"
      >
        <RouterLink
          :to="item.to"
          class="nav-item"
          :class="{ active: isActive(item.to, item.exact) }"
        >
          <Icon
            :icon="item.icon"
            class="w-4.5 h-4.5"
          />
          <span>{{ item.label }}</span>
        </RouterLink>
        <template #content>
          {{ item.label }}
        </template>
      </HoverTooltip>

      <!-- Configuration -->
      <div class="section-separator" />
      <div class="section-label">
        Configuration
      </div>
      <HoverTooltip
        placement="right"
        block
        :disabled="!sidebarCollapsed"
      >
        <RouterLink
          to="/agents"
          class="nav-item"
          :class="{ active: isActive('/agents') }"
        >
          <Icon
            icon="lucide:bot"
            class="w-4.5 h-4.5"
          />
          <span>Agents</span>
        </RouterLink>
        <template #content>
          Agents
        </template>
      </HoverTooltip>
      <HoverTooltip
        placement="right"
        block
        :disabled="!sidebarCollapsed"
      >
        <RouterLink
          to="/memory-spaces"
          class="nav-item"
          :class="{ active: isActive('/memory-spaces') }"
        >
          <Icon
            icon="lucide:brain"
            class="w-4.5 h-4.5"
          />
          <span>Memories</span>
        </RouterLink>
        <template #content>
          Memory Folders
        </template>
      </HoverTooltip>
      <!-- Activity -->
      <div class="section-separator" />
      <div class="section-label">
        Activity
      </div>

      <HoverTooltip
        placement="right"
        block
        :disabled="!sidebarCollapsed"
      >
        <RouterLink
          to="/instances"
          class="nav-item"
          :class="{ active: isActive('/instances') }"
          :aria-label="hasAwaitingApproval ? 'Instances — approval required' : 'Instances'"
        >
          <span class="relative inline-flex h-4.5 w-4.5 shrink-0 items-center justify-center">
            <Icon
              icon="lucide:activity"
              class="w-4.5 h-4.5"
            />
            <span
              v-if="hasAwaitingApproval"
              class="collapsed-hitl-indicator absolute -right-1.5 -top-1.5 h-3 w-3 items-center justify-center"
              aria-hidden="true"
            >
              <span class="absolute h-full w-full rounded-full bg-amber-400/50 animate-ping" />
              <span class="relative h-2.5 w-2.5 rounded-full bg-amber-400 ring-2 ring-theme-950" />
            </span>
          </span>
          <span>Instances</span>
          <span
            v-if="hasAwaitingApproval"
            class="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse ml-1 shrink-0"
          />
          <div
            v-if="activeWorkCount"
            class="rounded-full flex justify-center items-center bg-accent-400 text-xs text-white w-5 h-5 ml-2"
          >
            <span v-if="activeWorkCount > 9">9+</span>
            <span v-else>{{ activeWorkCount }}</span>
          </div>
        </RouterLink>
        <template #content>
          {{ hasAwaitingApproval ? "Instances — approval required" : "Instances" }}
        </template>
      </HoverTooltip>

      <HoverTooltip
        placement="right"
        block
        :disabled="!sidebarCollapsed"
      >
        <RouterLink
          to="/activity"
          class="nav-item"
          :class="{ active: isActive('/activity') }"
        >
          <Icon
            icon="lucide:list-tree"
            class="w-4.5 h-4.5"
          />
          <span>Activity Log</span>
        </RouterLink>
        <template #content>
          Activity Log
        </template>
      </HoverTooltip>

      <HoverTooltip
        placement="right"
        block
        :disabled="!sidebarCollapsed"
      >
        <RouterLink
          to="/usage"
          class="nav-item"
          :class="{ active: isActive('/usage') }"
        >
          <Icon
            icon="lucide:bar-chart-3"
            class="w-4.5 h-4.5"
          />
          <span>Usage</span>
        </RouterLink>
        <template #content>
          Usage
        </template>
      </HoverTooltip>

      <!-- Settings -->
      <div class="section-separator" />
      <div class="section-label">
        Settings
      </div>
      <HoverTooltip
        v-for="item in settingsItems"
        :key="item.to"
        placement="right"
        block
        :disabled="!sidebarCollapsed"
      >
        <RouterLink
          :to="item.to"
          class="nav-item"
          :class="{ active: isActive(item.to, item.exact) }"
        >
          <Icon
            :icon="item.icon"
            class="w-4.5 h-4.5"
          />
          <span>{{ item.label }}</span>
        </RouterLink>
        <template #content>
          {{ item.label }}
        </template>
      </HoverTooltip>
    </nav>

    <!-- Status Footer -->
    <div class="status-section px-3 py-3 shrink-0 relative">
      <button
        ref="statusButtonRef"
        class="status-trigger w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-theme-800/60 transition-colors text-left"
        :aria-expanded="showStatusPopover"
        @click="showStatusPopover = !showStatusPopover"
      >
        <span
          class="w-2 h-2 rounded-full shrink-0"
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
        <span class="text-[11px] text-theme-400 truncate flex-1">
          <template v-if="!wsConnected">Connecting...</template>
          <template v-else-if="hasAwaitingApproval">Needs Attention</template>
          <template v-else-if="instances.length > 0">Agents Running...</template>
          <template v-else-if="memoryJobsStore.hasRunningJobs">{{ memoryJobsStore.statusLabel }}</template>
          <template v-else-if="!providerStore.providers.length">No providers</template>
          <template v-else>Ready</template>
        </span>
        <Icon
          icon="lucide:chevron-up"
          class="w-3 h-3 text-theme-600 shrink-0 transition-transform"
          :class="{ 'rotate-180': showStatusPopover }"
        />
      </button>

      <!-- Status Popover -->
      <StatusPopover
        :show="showStatusPopover"
        :anchor-el="statusButtonRef"
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
