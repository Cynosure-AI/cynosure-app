<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useProviderStore } from './stores/provider.store'
import { useChatStore } from './stores/chat.store'
import { useAgentStore } from './stores/agent-runtime.store'
import { useAgentDefinitionsStore } from './stores/agent-definitions.store'
import { usePreferencesStore } from './stores/preferences.store'
import { useNotificationStore } from './stores/notification.store'
import { api, wsConnected } from './api/client'
import AppSidebar from './components/layout/AppSidebar.vue'
import ModalDialog from './components/shared/ModalDialog.vue'
import { RouterView, useRoute } from 'vue-router'
import { Icon } from '@iconify/vue'
import { ref, watch } from 'vue'
import { useSidebar } from './composables/useSidebar'

const providerStore = useProviderStore()
const chatStore = useChatStore()
const agentStore = useAgentStore()
const agentDefs = useAgentDefinitionsStore()
const notificationStore = useNotificationStore()

// Initialize preferences early so theme is applied before first render
usePreferencesStore()

const { sidebarOpen, sidebarCollapsed, close: closeSidebar } = useSidebar()
const route = useRoute()

// Close mobile sidebar on route change
watch(() => route.path, () => closeSidebar())

const mcpAuthRequests = ref<{ serverId: string; serverName: string; authUrl: string }[]>([])
const mcpAuthOpened = ref<Set<string>>(new Set())
const mcpAuthReconnecting = ref<string | null>(null)

const cleanups: (() => void)[] = []

async function loadAllStores() {
  await providerStore.loadProviders()
  await agentDefs.load()
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

onMounted(async () => {
  loadAllStores()

  // Sync tool selection if an agent was persisted
  if (chatStore.activeAgentId) {
    const agent = agentDefs.get(chatStore.activeAgentId)
    if (agent?.tools?.length) {
      agentStore.selectedToolNames = [...agent.tools]
    }
  }

  // Set up WebSocket event listeners
  cleanups.push(
    api.chat.onStreamStart((data) => chatStore.handleStreamStart(data)),
    api.chat.onStreamChunk((data) => chatStore.handleStreamChunk(data)),
    api.chat.onStreamThinking((data) => chatStore.handleStreamThinking(data)),
    api.chat.onStreamImages((data) => chatStore.handleStreamImages(data)),
    api.chat.onStreamReset((data) => chatStore.handleStreamReset(data)),
    api.chat.onStreamUsage((data) => chatStore.handleStreamUsage(data)),
    api.chat.onStreamEnd((data) => chatStore.handleStreamEnd(data)),
    api.chat.onStreamError((data) => chatStore.handleStreamError(data)),
    api.chat.onSubAgentStreamStart((data) => chatStore.handleSubAgentStreamStart(data)),
    api.chat.onSubAgentStreamChunk((data) => chatStore.handleSubAgentStreamChunk(data)),
    api.chat.onSubAgentStreamThinking((data) => chatStore.handleSubAgentStreamThinking(data)),
    api.chat.onSubAgentStreamImages((data) => chatStore.handleSubAgentStreamImages(data)),
    api.chat.onSubAgentStreamEnd((data) => chatStore.handleSubAgentStreamEnd(data)),
    api.chat.onTitleUpdated((data) => chatStore.handleTitleUpdated(data)),
    api.chat.onNewMessage((data) => chatStore.handleNewMessage(data)),
    api.chat.onPostAction((data) => chatStore.handlePostAction(data)),
    // Agent event listeners
    api.agent.onHITLRequest((data) => agentStore.handleHITLRequest(data as any)),
    api.agent.onHITLResolved(() => agentStore.dismissHITL()),
    api.agent.onExecutionUpdate((data) => agentStore.handleExecutionUpdate(data as any)),
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
  <div class="flex h-screen bg-zinc-950 text-zinc-100 antialiased selection:bg-blue-500/30 selection:text-blue-200">
    <!-- Mobile sidebar backdrop -->
    <Transition
      enter-active-class="transition-opacity duration-200"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-150"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="sidebarOpen"
        class="fixed inset-0 z-40 bg-black/60 md:hidden"
        @click="closeSidebar"
      />
    </Transition>

    <!-- Sidebar: always visible on md+, slide-in overlay on mobile -->
    <div
      class="fixed inset-y-0 left-0 z-50 w-60 transition-all duration-200 md:static md:translate-x-0"
      :class="[
        sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        sidebarCollapsed ? 'md:w-16' : ''
      ]"
    >
      <AppSidebar />
    </div>

    <div class="flex flex-col flex-1 min-w-0 bg-zinc-950 p-2 pl-0 md:pl-0">
      <!-- Mobile header with hamburger -->
      <div class="flex items-center gap-2 px-2 py-1.5 md:hidden">
        <button
          class="p-2 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
          @click="sidebarOpen = !sidebarOpen"
        >
          <Icon
            icon="lucide:menu"
            class="w-5 h-5"
          />
        </button>
        <span class="text-sm font-semibold text-zinc-200">OpenAgent</span>
      </div>
      <main class="flex-1 overflow-hidden bg-zinc-900 ring-1 ring-black/5 dark:ring-white/10 rounded-xl relative flex flex-col shadow-2xl ml-2 md:ml-0">
        <RouterView />
      </main>
    </div>

    <!-- MCP Auth Requests Modal -->
    <ModalDialog
      :show="mcpAuthRequests.length > 0"
      title="Authentication Required"
      icon="lucide:shield-alert"
      icon-color="blue"
      @close="dismissAuthRequest(mcpAuthRequests[0]?.serverId)"
    >
      <p class="text-zinc-400 leading-relaxed">
        The MCP server <strong class="text-zinc-200">{{ mcpAuthRequests[0]?.serverName }}</strong> requires external authorization before it can connect. Please click the unblock link below.
      </p>
      <template #actions>
        <a
          v-if="!mcpAuthOpened.has(mcpAuthRequests[0]?.serverId)"
          :href="mcpAuthRequests[0]?.authUrl"
          target="_blank"
          class="w-full px-4 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-center font-medium transition-colors shadow-lg shadow-blue-500/20"
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
          class="w-full px-4 py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl text-center font-medium transition-colors"
          @click="dismissAuthRequest(mcpAuthRequests[0]?.serverId)"
        >
          Dismiss
        </button>
      </template>
    </ModalDialog>
  </div>
</template>
