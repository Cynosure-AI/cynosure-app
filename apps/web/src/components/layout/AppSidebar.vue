<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useProviderStore } from "../../stores/provider.store";
import { useNotificationStore } from "../../stores/notification.store";
import { useAgentDefinitionsStore } from "../../stores/agent-definitions.store";
import { useChatStore } from "../../stores/chat.store";
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
const { close: closeSidebar, sidebarCollapsed, toggleCollapse } = useSidebar();
const { logoIconUrl, logoTextUrl } = useAppBranding();

const showStatusPopover = ref(false);
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

async function loadInstances() {
  try {
    instances.value = await api.instances.list();
  } catch {
    // silently ignore
  }
}

async function navigateToInstance(instance: AgentInstance) {
  showStatusPopover.value = false;
  closeSidebar();
  await chatStore.setActiveAgent(instance.agentId || null);
  if (instance.conversationId) {
    await chatStore.selectConversation(instance.conversationId);
  }
  router.push("/triggers/chat");
}

onMounted(() => {
  loadInstances();
  instancePollTimer = setInterval(loadInstances, 3_000);
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
  unsubHITLRequest?.();
  unsubExecutionUpdate?.();
});

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
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
    router.push("/triggers/chat");
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
  { to: "/triggers/channels", icon: "lucide:radio", label: "Channels" },
];

const settingsItems: NavItem[] = [
  { to: "/settings", icon: "lucide:settings", label: "Settings", exact: true },
  { to: "/settings/mcp", icon: "lucide:plug", label: "MCPs" },
];
</script>

<template>
  <aside
    class="bg-theme-950 flex flex-col h-full shrink-0 transition-all duration-200 overflow-hidden"
    :class="sidebarCollapsed ? 'w-60 md:w-16 sidebar-collapsed' : 'w-60'"
  >
    <!-- Brand -->
    <div class="brand-area px-1 p-3 mt-2 mb-2 flex items-center gap-3 shrink-0">
      <img
        :src="logoIconUrl"
        alt="Cynosure"
        class="brand-logo-icon w-8 h-8 object-contain"
      >
      <img
        :src="logoTextUrl"
        alt="Cynosure"
        class="brand-logo-text h-8 w-auto max-w-36 object-contain flex-1"
      >

      <!-- Notification Bell -->
      <div class="relative">
        <button
          ref="bellBtnRef"
          class="p-1.5 rounded-lg hover:bg-theme-800 transition-colors relative"
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
              class="w-80 bg-theme-900 border border-theme-700 rounded-xl shadow-2xl overflow-hidden z-200"
              :style="notifPopoverStyle"
              @click.stop
            >
              <!-- Header -->
              <div class="flex items-center justify-between px-3 py-2.5 border-b border-theme-800">
                <span class="text-xs font-semibold text-theme-200">Notifications</span>
                <div class="flex items-center gap-1">
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
                >
                  <!-- Severity indicator -->
                  <div class="mt-1 shrink-0">
                    <Icon
                      :icon="notif.severity === 'critical'
                        ? 'lucide:alert-triangle'
                        : notif.severity === 'warning'
                          ? 'lucide:alert-circle'
                          : 'lucide:info'
                      "
                      class="w-3.5 h-3.5"
                      :class="{
                        'text-red-400': notif.severity === 'critical',
                        'text-amber-400': notif.severity === 'warning',
                        'text-accent-400': notif.severity === 'info',
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
                        formatTimeAgo(notif.createdAt)
                      }}</span>
                    </div>
                  </div>
                  <!-- Delete button -->
                  <button
                    class="mt-1 shrink-0 text-theme-600 hover:text-theme-300 transition-colors"
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
          to="/chat"
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

      <!-- Agents -->
      <div class="section-separator" />
      <div class="section-label">
        Agents
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
          <span>My Agents</span>
        </RouterLink>
        <template #content>
          My Agents
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
          <span>Memory Spaces</span>
        </RouterLink>
        <template #content>
          Memory Spaces
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

      <!-- Instances -->
      <div class="section-separator" />
      <div class="section-label">
        Instances
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
        >
          <Icon
            icon="lucide:activity"
            class="w-4.5 h-4.5"
          />
          <span>View all</span>
          <span
            v-if="hasAwaitingApproval"
            class="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse ml-1 shrink-0"
          />
          <div
            v-if="instances.length"
            class="rounded-full flex justify-center items-center bg-accent-400 text-xs text-white w-5 h-5 ml-2"
          >
            <span v-if="instances.length > 9">9+</span>
            <span v-else>{{ instances.length }}</span>
          </div>
        </RouterLink>
        <template #content>
          Instances
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

    <!-- Collapse toggle (desktop only) -->
    <div class="shrink-0 hidden md:block px-3 py-1 border-t border-theme-800/50">
      <button
        class="w-full flex items-center gap-2.5 rounded-lg text-theme-500 hover:text-theme-300 hover:bg-theme-800/50 transition-colors"
        :class="sidebarCollapsed ? 'justify-center p-2' : 'px-2 py-1.5'"
        :title="sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
        @click="toggleCollapse"
      >
        <Icon
          icon="lucide:panel-left-close"
          class="w-4 h-4 shrink-0 transition-transform"
          :class="{ 'rotate-180': sidebarCollapsed }"
        />
        <span
          v-show="!sidebarCollapsed"
          class="text-[11px]"
        >Collapse</span>
      </button>
    </div>

    <!-- Status Footer -->
    <div class="status-section px-3 py-3 shrink-0 relative">
      <button
        class="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-theme-800/60 transition-colors text-left"
        @click="showStatusPopover = !showStatusPopover"
      >
        <span
          class="w-2 h-2 rounded-full shrink-0"
          :class="{
            'bg-red-500 animate-pulse': !wsConnected,
            'bg-amber-500 animate-pulse': wsConnected && hasAwaitingApproval,
            'bg-accent-500 animate-pulse':
              wsConnected && instances.length > 0 && !hasAwaitingApproval,
            'bg-emerald-500':
              wsConnected &&
              instances.length === 0 &&
              providerStore.providers.length > 0,
            'bg-theme-600': wsConnected && !providerStore.providers.length,
          }"
        />
        <span class="text-[11px] text-theme-400 truncate flex-1">
          <template v-if="!wsConnected">Connecting...</template>
          <template v-else-if="hasAwaitingApproval">Needs Attention</template>
          <template v-else-if="instances.length > 0">Agents Running...</template>
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
        :instances="instances"
        @close="showStatusPopover = false"
        @navigate-to-instance="navigateToInstance"
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

  .sidebar-collapsed .section-label {
    display: none;
  }

  .sidebar-collapsed .section-separator {
    margin: 0.375rem auto 0.375rem;
    width: 60%;
    opacity: 1;
  }

  .sidebar-collapsed .brand-area {
    justify-content: center;
    padding-inline: 0;
    gap: 0;
  }

  .sidebar-collapsed .brand-area>*:not(:first-child) {
    display: none;
  }

  .sidebar-collapsed .brand-logo-icon {
    display: block;
  }

  .sidebar-collapsed .status-section button {
    justify-content: center;
    gap: 0;
    padding: 0.5rem;
  }

  .sidebar-collapsed .status-section button>*:not(:first-child) {
    display: none;
  }
}
</style>
