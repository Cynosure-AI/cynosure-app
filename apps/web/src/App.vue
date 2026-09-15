<script setup lang="ts">
import { nextTick, onMounted, onUnmounted } from 'vue'
import { useProviderStore } from './stores/provider.store'
import { useChatStore } from './stores/chat.store'
import { useAgentStore, type HITLRequest } from './stores/agent-runtime.store'
import { useAgentDefinitionsStore } from './stores/agent-definitions.store'
import { usePreferencesStore } from './stores/preferences.store'
import { useNotificationStore } from './stores/notification.store'
import { api } from './api/client'
import { wsConnected } from './api/http'
import AppSidebar from './components/layout/AppSidebar.vue'
import ModalDialog from './components/shared/ModalDialog.vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import { computed, ref, watch } from 'vue'
import { useSidebar } from './composables/useSidebar'

const providerStore = useProviderStore()
const chatStore = useChatStore()
const agentStore = useAgentStore()
const agentDefs = useAgentDefinitionsStore()
const notificationStore = useNotificationStore()

// Initialize preferences early so theme is applied before first render
const preferencesStore = usePreferencesStore()

const { sidebarOpen, sidebarCollapsed, close: closeSidebar } = useSidebar()
const route = useRoute()
const router = useRouter()
const isOnboardingRoute = computed(() => route.name === 'onboarding')

type ElectronDesktopApi = {
  onNewChatRequested?: (listener: () => void) => () => void
}

const electron = (window as unknown as { electron?: ElectronDesktopApi }).electron

// Close mobile sidebar on route change
watch(() => route.path, () => closeSidebar())

const mcpAuthRequests = ref<{ serverId: string; serverName: string; authUrl: string }[]>([])
const mcpAuthOpened = ref<Set<string>>(new Set())
const mcpAuthReconnecting = ref<string | null>(null)

const cleanups: (() => void)[] = []

async function loadAllStores() {
  await preferencesStore.loadUserSettings()
  await providerStore.loadProviders()
  await agentDefs.load()
  await chatStore.loadMemoryFolders()
  await chatStore.loadConversations()
  chatStore.syncAgentBaseline()
  await agentStore.loadTools()
  await notificationStore.load()
}

// Reload stores when server connection is (re)established
watch(wsConnected, (connected) => {
  if (connected) loadAllStores()
})

function handleMcpAuth(data: { serverId: string; serverName: string; authUrl: string }) {
  if (!mcpAuthRequests.value.find(r => r.serverId === data.serverId)) {
    mcpAuthRequests.value.push(data)
  }
}

function dismissAuthRequest(serverId: string) {
  mcpAuthRequests.value = mcpAuthRequests.value.filter(r => r.serverId !== serverId)
  mcpAuthOpened.value.delete(serverId)
  mcpAuthReconnecting.value = null
}

function openAuthPage(serverId: string, authUrl: string) {
  window.open(authUrl, '_blank')
  mcpAuthOpened.value.add(serverId)
}

async function reconnectAfterAuth(serverId: string) {
  mcpAuthReconnecting.value = serverId
  try {
    await api.mcp.reconnectServer(serverId)
    dismissAuthRequest(serverId)
    agentStore.loadTools()
  } catch {
    mcpAuthReconnecting.value = null
  }
}

function handleMcpAuthComplete(data: { serverId: string; serverName: string; toolCount: number }) {
  // Auto-dismiss any auth modal for this server and refresh tools
  dismissAuthRequest(data.serverId)
  agentStore.loadTools()
}

function isHITLRequestPayload(data: unknown): data is HITLRequest {
  const d = data as Partial<HITLRequest> | null
  return Boolean(d && typeof d.taskId === 'string' && Array.isArray(d.toolCalls))
}

function isExecutionUpdatePayload(data: unknown): data is { event: string; data: Record<string, unknown> } {
  const d = data as { event?: unknown; data?: unknown } | null
  return Boolean(d && typeof d.event === 'string' && d.data && typeof d.data === 'object')
}

onMounted(async () => {
  loadAllStores()

  if (electron?.onNewChatRequested) {
    cleanups.push(electron.onNewChatRequested(async () => {
      await chatStore.startNewChat()
      await router.push({ name: 'triggers-chat' })
      await nextTick()
      document.querySelector<HTMLTextAreaElement>('.chat-input-bar textarea')?.focus()
    }))
  }

  // Set up WebSocket event listeners
  cleanups.push(
    api.chat.onStreamStart((data) => chatStore.handleStreamStart(data)),
    api.chat.onStreamChunk((data) => chatStore.handleStreamChunk(data)),
    api.chat.onStreamThinking((data) => chatStore.handleStreamThinking(data)),
    api.chat.onStreamImages((data) => chatStore.handleStreamImages(data)),
    api.chat.onStreamVideos((data) => chatStore.handleStreamVideos(data)),
    api.chat.onStreamReset((data) => chatStore.handleStreamReset(data)),
    api.chat.onStreamDiscard((data) => chatStore.handleStreamDiscard(data)),
    api.chat.onStreamUsage((data) => chatStore.handleStreamUsage(data)),
    api.chat.onStreamEnd((data) => chatStore.handleStreamEnd(data)),
    api.chat.onStreamError((data) => chatStore.handleStreamError(data)),
    api.chat.onExecutionState((data) => chatStore.handleChatExecutionState(data)),
    api.chat.onQueueChanged((data) => chatStore.handleQueueChanged(data)),
    api.chat.onSubAgentStreamStart((data) => chatStore.handleSubAgentStreamStart(data)),
    api.chat.onSubAgentStreamChunk((data) => chatStore.handleSubAgentStreamChunk(data)),
    api.chat.onSubAgentStreamThinking((data) => chatStore.handleSubAgentStreamThinking(data)),
    api.chat.onSubAgentStreamImages((data) => chatStore.handleSubAgentStreamImages(data)),
    api.chat.onSubAgentStreamEnd((data) => chatStore.handleSubAgentStreamEnd(data)),
    api.chat.onTitleUpdated((data) => chatStore.handleTitleUpdated(data)),
    api.chat.onNewMessage((data) => chatStore.handleNewMessage(data)),
    api.chat.onChannelConversationState((data) => {
      void chatStore.handleChannelConversationState(data)
    }),
    api.chat.onCompactEvent((data) => chatStore.handleCompactEvent(data)),
    api.chat.onCompactStart((data) => chatStore.handleCompactStart(data)),
    api.chat.onCompactError((data) => chatStore.handleCompactError(data)),
    api.chat.onPostAction((data) => chatStore.handlePostAction(data)),
    // Agent event listeners
    api.agent.onHITLRequest((data) => {
      if (isHITLRequestPayload(data)) agentStore.handleHITLRequest(data)
    }),
    api.agent.onHITLResolved((data) => {
      const payload = data as { taskId?: string; conversationId?: string } | null
      agentStore.dismissHITLByTaskId(payload?.taskId)
      agentStore.dismissHITLByConversation(payload?.conversationId)
    }),
    api.agent.onExecutionUpdate((data) => {
      if (isExecutionUpdatePayload(data)) agentStore.handleExecutionUpdate(data)
    }),
    api.agent.onPlanningStateUpdated((data) => {
      agentStore.handlePlanningStateUpdated(data)
    }),
    api.mcp.onAuthNeeded(handleMcpAuth),
    api.mcp.onAuthComplete(handleMcpAuthComplete),
    api.notifications.onCreated((data) => notificationStore.addFromWs(data))
  )
})

onUnmounted(() => {
  cleanups.forEach((fn) => fn())
})
</script>

<template>
  <div class="flex h-screen bg-theme-950 text-theme-100 antialiased selection:bg-accent-500/30 selection:text-accent-200">
    <!-- Mobile sidebar backdrop -->
    <Transition
      v-if="!isOnboardingRoute"
      enter-active-class="transition-opacity duration-200"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-150"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="sidebarOpen"
        class="fixed inset-0 z-30 bg-black/60 md:hidden"
        aria-hidden="true"
        @click="closeSidebar"
      />
    </Transition>

    <!-- Sidebar: always visible on md+, slide-in overlay on mobile -->
    <div
      v-if="!isOnboardingRoute"
      id="primary-navigation"
      class="fixed inset-y-0 left-0 z-30 w-72 transition-all duration-200 md:static md:translate-x-0"
      :class="[
        sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        sidebarCollapsed ? 'md:w-16' : ''
      ]"
    >
      <AppSidebar />
    </div>

    <div
      class="flex flex-col flex-1 min-w-0 bg-theme-950"
      :class="isOnboardingRoute ? '' : 'p-2 pl-0 md:pl-2'"
    >
      <!-- Mobile header with hamburger -->
      <div
        v-if="!isOnboardingRoute"
        class="flex items-center gap-2 px-2 py-1.5 md:hidden"
      >
        <button
          type="button"
          class="p-2 rounded-lg text-theme-400 hover:text-theme-100 hover:bg-theme-800 transition-colors"
          aria-label="Open navigation"
          aria-controls="primary-navigation"
          :aria-expanded="sidebarOpen"
          @click="sidebarOpen = !sidebarOpen"
        >
          <Icon
            icon="lucide:menu"
            class="w-5 h-5"
          />
        </button>
        <span class="text-sm font-semibold text-theme-200">Cynosure</span>
      </div>
      <main
        class="flex-1 overflow-hidden relative flex flex-col"
        :class="isOnboardingRoute
          ? 'bg-theme-950'
          : 'bg-theme-900 ring-1 ring-black/5 dark:ring-white/10 rounded-xl shadow-2xl ml-2 md:ml-0'"
      >
        <RouterView />
      </main>
    </div>

    <!-- MCP Auth Requests Modal -->
    <ModalDialog
      :show="mcpAuthRequests.length > 0"
      title="Authentication Required"
      icon="lucide:shield-alert"
      icon-color="accent"
      layer="nested"
      @close="dismissAuthRequest(mcpAuthRequests[0]?.serverId)"
    >
      <p class="text-theme-400 leading-relaxed">
        The MCP server <strong class="text-theme-200">{{ mcpAuthRequests[0]?.serverName }}</strong> requires external authorization before it can connect. Please click the unblock link below.
      </p>
      <template #actions>
        <a
          v-if="!mcpAuthOpened.has(mcpAuthRequests[0]?.serverId)"
          :href="mcpAuthRequests[0]?.authUrl"
          target="_blank"
          class="w-full px-4 py-3 bg-accent-600 hover:bg-accent-500 text-white rounded-xl text-center font-medium transition-colors shadow-lg shadow-accent-500/20"
          @click.prevent="openAuthPage(mcpAuthRequests[0]?.serverId, mcpAuthRequests[0]?.authUrl)"
        >
          Open Authorization Page
        </a>
        <button
          v-if="mcpAuthOpened.has(mcpAuthRequests[0]?.serverId)"
          class="w-full px-4 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-center font-medium transition-colors shadow-lg shadow-emerald-500/20"
          :disabled="mcpAuthReconnecting === mcpAuthRequests[0]?.serverId"
          @click="reconnectAfterAuth(mcpAuthRequests[0]?.serverId)"
        >
          {{ mcpAuthReconnecting === mcpAuthRequests[0]?.serverId ? 'Connecting...' : 'I\'ve Authorized — Reconnect' }}
        </button>
        <button
          class="w-full px-4 py-3 bg-theme-800 hover:bg-theme-700 text-theme-300 rounded-xl text-center font-medium transition-colors"
          @click="dismissAuthRequest(mcpAuthRequests[0]?.serverId)"
        >
          Dismiss
        </button>
      </template>
    </ModalDialog>
  </div>
</template>
