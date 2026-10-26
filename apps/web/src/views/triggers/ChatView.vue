<script setup lang="ts">
import ChatHeaderBar from '../../components/chat/ChatHeaderBar.vue'
import ChatPanel from '../../components/chat/ChatPanel.vue'
import InputBar from '../../components/chat/InputBar.vue'
import PlanningTaskList from '../../components/chat/PlanningTaskList.vue'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useChatStore, type Conversation } from '../../stores/chat.store'
import { useAgentStore } from '../../stores/agent-runtime.store'
import { useProviderStore } from '../../stores/provider.store'
import { api } from '../../api/client'
import { wsConnected } from '../../api/http'
import { Icon } from '@iconify/vue'
import AgentAvatar from '../../components/shared/AgentAvatar.vue'
import { useCynoStore } from '../../stores/cyno.store'
import { useMcpServers } from '../../composables/useMcpServers'
import { useFreshChat } from '../../composables/useFreshChat'
import { INTRO_PILLS_MS, INTRO_PILL_STAGGER_MS } from '../../components/chat/chatIntro'
import { getToolNamespaceIcon } from '../../utils/tool-namespace-icons'

const chatStore = useChatStore()
const agentStore = useAgentStore()
const { servers: mcpServers } = useMcpServers()
const providerStore = useProviderStore()
const cyno = useCynoStore()
const route = useRoute()
const router = useRouter()
const inputBarRef = ref<InstanceType<typeof InputBar> | null>(null)
const isDragOver = ref(false)
const taskListOpen = ref(false)
const chatSearchOpen = ref(false)
const needsAgent = ref(false)
const needsMemory = ref(false)
const needsTools = ref(false)
let dragCounter = 0
let syncingFromRoute = false
const canUseChat = computed(() => providerStore.providersLoaded && providerStore.providers.length > 0)
const hasNoProviders = computed(() => providerStore.providersLoaded && providerStore.providers.length === 0)
const selectedMcpNamespaces = computed(() => {
  if (chatStore.loadingMessages || chatStore.messages.length > 0) return []

  const selectedTools = new Set(chatStore.selectedToolNames ?? [])
  const availableTools = agentStore.availableTools ?? []
  const namespaces = new Map<string, { id: string; label: string }>()
  for (const tool of availableTools) {
    if (tool.namespace.id.startsWith('mcp:') && selectedTools.has(tool.key)) {
      namespaces.set(tool.namespace.id, tool.namespace)
    }
  }

  const serversById = new Map(mcpServers.value.map((server) => [server.id, server]))
  return [...namespaces.values()].map((namespace) => {
    const server = serversById.get(namespace.id.slice(4))
    return {
      id: namespace.id,
      name: server?.customName || server?.name || namespace.label,
      iconUrl: server?.icon_url,
    }
  })
})

function removeMcpSelection(namespaceId: string): void {
  const toolKeys = new Set((agentStore.availableTools ?? [])
    .filter((tool) => tool.namespace.id === namespaceId)
    .map((tool) => tool.key))
  chatStore.setSelectedToolNames((chatStore.selectedToolNames ?? []).filter((key) => !toolKeys.has(key)))
  chatStore.markOverridesModified()
}

const showCenteredComposer = computed(() => {
  const routeConversationId = Array.isArray(route.params.conversationId)
    ? route.params.conversationId[0]
    : route.params.conversationId

  return canUseChat.value &&
    !routeConversationId &&
    !chatStore.activeConversationId &&
    !chatStore.loadingMessages &&
    chatStore.messages.length === 0
})

const { setFreshChat } = useFreshChat()
watch(showCenteredComposer, setFreshChat, { immediate: true })

// Pills ready with a fresh chat arrive after its intro; ones that load later
// arrive at once. Each delay is fixed when its pill first renders, so later
// re-renders cannot shift an animation already underway.
let introStartedAt = 0
const pillDelays = new Map<string, number>()
watch(showCenteredComposer, (centered) => {
  if (!centered) return
  introStartedAt = performance.now()
  pillDelays.clear()
}, { immediate: true })

function pillDelay(key: string, index: number): string {
  let delay = pillDelays.get(key)
  if (delay === undefined) {
    delay = Math.max(0, INTRO_PILLS_MS - (performance.now() - introStartedAt)) + index * INTRO_PILL_STAGGER_MS
    pillDelays.set(key, delay)
  }
  return `${delay}ms`
}

const latestAgentChats = computed(() => {
  const agentId = chatStore.activeAgentId
  if (!agentId) return []

  return [...chatStore.conversations]
    .filter(conversation => conversation.agentId === agentId && conversation.origin === 'chat' && !conversation.temporary)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 4)
})

const onboardingPills = computed(() => [
  ...(needsAgent.value ? [{ label: 'Create Your First Agent', icon: 'lucide:bot', to: { name: 'agents' } }] : []),
  ...(needsMemory.value ? [{ label: 'Setup Memory', icon: 'lucide:brain', to: { name: 'settings', query: { category: 'memory' } } }] : []),
  ...(needsTools.value ? [{ label: 'Install Tools', icon: 'lucide:blocks', to: { name: 'settings-mcp', query: { panel: 'browse' } } }] : []),
])

async function loadOnboardingPills(): Promise<void> {
  needsAgent.value = false
  needsMemory.value = false
  needsTools.value = false
  const [agents, embedding, servers] = await Promise.allSettled([
    api.agents.list(),
    api.memory.getEmbeddingConfig(),
    api.mcp.listServers(),
  ])
  if (agents.status === 'fulfilled') needsAgent.value = agents.value.length === 0
  if (embedding.status === 'fulfilled') needsMemory.value = !embedding.value.providerId && !embedding.value.baseUrl
  if (servers.status === 'fulfilled') {
    needsTools.value = servers.value.length === 0
    mcpServers.value = servers.value
  }
}

watch(wsConnected, (connected) => {
  if (connected) void loadOnboardingPills()
}, { immediate: true })

const hasPlanningTasks = computed(() => Boolean(agentStore.planningState?.items.length))
const hasSearchableMessages = computed(() => chatStore.messages.some(message =>
  message.role !== 'system'
  && message.role !== 'tool'
  && message.content.trim().length > 0
))

function onChatSearchShortcut(event: KeyboardEvent): void {
  if (
    event.key.toLocaleLowerCase() !== 'f'
    || (!event.ctrlKey && !event.metaKey)
    || event.altKey
    || event.shiftKey
    || !hasSearchableMessages.value
  ) return

  event.preventDefault()
  chatSearchOpen.value = true
}

onMounted(() => {
  document.addEventListener('keydown', onChatSearchShortcut)
  window.addEventListener('pagehide', discardIncognitoOnUnload)
})

// A closing or reloading tab cannot wait for a response, so send the discard
// with keepalive. The server purges anything this misses on its next start.
function discardIncognitoOnUnload(): void {
  const conversationId = chatStore.activeConversationId
  if (conversationId && chatStore.activeIsTemporary) {
    void api.chat.discardConversation(conversationId, { keepalive: true }).catch(() => undefined)
  }
}

watch(
  () => agentStore.planningState?.runId,
  (runId) => {
    taskListOpen.value = Boolean(runId)
  },
  { immediate: true }
)

function onDragEnter(e: DragEvent) {
  if (!canUseChat.value) return
  e.preventDefault()
  dragCounter++
  isDragOver.value = true
}

function onDragLeave(e: DragEvent) {
  e.preventDefault()
  dragCounter--
  if (dragCounter <= 0) {
    dragCounter = 0
    isDragOver.value = false
  }
}

function onDragOver(e: DragEvent) {
  e.preventDefault()
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  dragCounter = 0
  isDragOver.value = false
  const files = e.dataTransfer?.files
  if (files?.length && inputBarRef.value) {
    inputBarRef.value.processFiles(Array.from(files))
  }
}

function sendQuickResponse(suggestion: string): void {
  void inputBarRef.value?.sendSuggestion(suggestion)
}

async function openRecentChat(conversation: Conversation): Promise<void> {
  await chatStore.selectConversation(conversation.id, conversation.agentId ?? null)
  await router.push({ name: 'conversation', params: { conversationId: conversation.id } })
}

onUnmounted(() => {
  setFreshChat(false)
  document.removeEventListener('keydown', onChatSearchShortcut)
  window.removeEventListener('pagehide', discardIncognitoOnUnload)
  const conversationId = chatStore.activeConversationId
  // Leaving the chat view ends an incognito chat unless it was saved.
  if (conversationId && chatStore.activeIsTemporary) void chatStore.discardIfTemporary(conversationId)
  else if (conversationId) chatStore.markConversationRead(conversationId)
  chatStore.setIncognito(false)
})

watch(
  () => route.params.conversationId,
  async (param) => {
    const conversationId = Array.isArray(param) ? param[0] : param
    if (!conversationId || chatStore.activeConversationId === conversationId) return
    syncingFromRoute = true
    try {
      await chatStore.selectConversation(conversationId)
    } catch (error) {
      console.error('[chat] Failed to open conversation from route:', error)
      router.replace({ name: 'triggers-chat' })
    } finally {
      syncingFromRoute = false
    }
  },
  { immediate: true }
)

watch(
  () => chatStore.activeConversationId,
  () => {
    chatSearchOpen.value = false
  }
)

watch(
  [() => chatStore.activeConversationId, () => route.name],
  ([conversationId]) => {
    if (syncingFromRoute || (route.name !== 'triggers-chat' && route.name !== 'conversation')) return
    const routeConversationId = typeof route.params.conversationId === 'string' ? route.params.conversationId : null
    if (conversationId && routeConversationId !== conversationId) {
      router.replace({ name: 'conversation', params: { conversationId } })
    } else if (!conversationId && route.name === 'conversation') {
      router.replace({ name: 'triggers-chat' })
    }
  }
)
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden">
    <!-- Header bar (full width) -->
    <ChatHeaderBar
      :has-planning-tasks="hasPlanningTasks"
      :task-list-open="taskListOpen"
      :planning-task-count="agentStore.planningState?.items.length ?? 0"
      @toggle-task-list="taskListOpen = !taskListOpen"
      @search-chat="chatSearchOpen = true"
    />

    <!-- Main content area -->
    <div class="flex flex-1 min-h-0 relative">
      <!-- Chat column: panel + input bar -->
      <div
        class="chat-column relative isolate flex flex-col flex-1 min-w-0"
        :class="{ 'chat-column--empty': showCenteredComposer }"
        @dragenter="onDragEnter"
        @dragleave="onDragLeave"
        @dragover="onDragOver"
        @drop="onDrop"
      >
        <div
          v-if="!wsConnected"
          class="flex flex-1 min-h-0 flex-col"
          data-testid="chat-initialising"
        >
          <ChatPanel />
        </div>

        <div
          v-else-if="!providerStore.providersLoaded"
          class="flex flex-1 items-center justify-center text-ink-muted"
          aria-label="Loading AI providers"
        >
          <Icon
            icon="lucide:loader-2"
            class="h-6 w-6 animate-spin"
          />
        </div>

        <div
          v-else-if="hasNoProviders"
          class="flex flex-1 items-center justify-center px-6 py-12"
          data-testid="chat-no-providers"
        >
          <div class="max-w-md text-center">
            <!-- Without a provider the assistant has nothing to think with yet. -->
            <div class="mx-auto mb-5 h-20 w-20">
              <AgentAvatar
                :name="cyno.name"
                :icon-url="cyno.displayIconUrl"
                :avatar="cyno.avatar"
                mood="sleepy"
                animate="always"
              />
            </div>
            <h2 class="mb-2 text-xl font-medium text-theme-100">
              Set up an AI provider to start chatting
            </h2>
            <p class="mb-6 text-sm leading-relaxed text-ink-muted">
              Chat needs an AI provider and model. Add one in Settings, then return here to begin a conversation.
            </p>
            <button
              type="button"
              class="inline-flex items-center gap-2 rounded-lg accent-action bg-accent-600 px-4 py-2.5 text-sm font-medium text-accent-on transition-colors hover:bg-accent-500"
              @click="router.push({ name: 'settings', query: { category: 'providers' } })"
            >
              <Icon
                icon="lucide:settings"
                class="h-4 w-4"
              />
              Configure providers
            </button>
          </div>
        </div>

        <template v-else>
          <!-- Chat area -->
          <div class="flex flex-col flex-1 min-h-0 relative">
            <ChatPanel
              :search-open="chatSearchOpen"
              @close-search="chatSearchOpen = false"
              @select-quick-response="sendQuickResponse"
            />

            <PlanningTaskList
              v-if="taskListOpen"
              @close="taskListOpen = false"
            />
          </div>

          <!-- Input bar (full width of chat column) -->
          <InputBar
            ref="inputBarRef"
            :has-selection-tabs="selectedMcpNamespaces.length > 0"
            class="order-2 md:order-0"
          >
            <template #selection-tabs>
              <div
                class="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                role="group"
                aria-label="Selected tools"
                tabindex="0"
              >
                <TransitionGroup
                  tag="div"
                  appear
                  enter-active-class="transition duration-200 ease-out"
                  enter-from-class="translate-y-1 opacity-0"
                  enter-to-class="translate-y-0 opacity-100"
                  leave-active-class="transition duration-150 ease-in"
                  leave-from-class="translate-y-0 opacity-100"
                  leave-to-class="translate-y-1 opacity-0"
                  move-class="transition-transform duration-200"
                  class="flex w-max min-w-full flex-nowrap items-center gap-1.5 px-0.5"
                  aria-label="Selected MCPs"
                >
                  <div
                    v-for="mcp in selectedMcpNamespaces"
                    :key="mcp.id"
                    data-mcp-chip
                    :title="mcp.name"
                    class="group inline-flex shrink-0 items-center gap-1.5 px-1 text-xs text-theme-200"
                  >
                    <img
                      v-if="mcp.iconUrl"
                      :src="mcp.iconUrl"
                      :alt="mcp.name"
                      class="h-3.5 w-3.5 shrink-0 rounded-full object-cover"
                    >
                    <Icon
                      v-else
                      :icon="getToolNamespaceIcon(mcp.id)"
                      class="h-3.5 w-3.5 shrink-0 text-ink-secondary"
                    />
                    <span class="max-w-32 truncate">{{ mcp.name }}</span>
                    <button
                      type="button"
                      class="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-theme-700 hover:text-theme-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                      :aria-label="`Remove ${mcp.name} tools from selection`"
                      @click="removeMcpSelection(mcp.id)"
                    >
                      <Icon
                        icon="lucide:x"
                        class="h-3 w-3"
                      />
                    </button>
                  </div>
                </TransitionGroup>
              </div>
            </template>
          </InputBar>

          <div
            v-if="showCenteredComposer && (onboardingPills.length || latestAgentChats.length)"
            class="recent-agent-chats order-1 md:order-0 mx-auto flex w-full max-w-5xl flex-wrap justify-center gap-2 px-4 pb-3"
            aria-label="Getting started and recent chats"
          >
            <RouterLink
              v-for="(pill, index) in onboardingPills"
              :key="pill.label"
              :to="pill.to"
              class="recent-agent-chat-pill inline-flex max-w-full items-center gap-1.5 rounded-full border border-accent-500/35 bg-accent-500/10 px-3 py-1.5 text-xs text-accent-fg shadow-sm transition-colors hover:border-accent-500/70 hover:bg-accent-500/20 hover:text-accent-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/70"
              :style="{ animationDelay: pillDelay(pill.label, index) }"
            >
              <Icon
                :icon="pill.icon"
                class="h-3.5 w-3.5 shrink-0"
              />
              <span>{{ pill.label }}</span>
            </RouterLink>
            <button
              v-for="(conversation, index) in latestAgentChats"
              :key="conversation.id"
              type="button"
              class="recent-agent-chat-pill inline-flex max-w-full items-center gap-1.5 rounded-full border border-theme-700/80 bg-theme-800/70 px-3 py-1.5 text-xs text-ink-secondary shadow-sm transition-colors hover:border-accent-500/50 hover:bg-theme-800 hover:text-theme-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/70"
              :style="{ animationDelay: pillDelay(conversation.id, onboardingPills.length + index) }"
              :title="conversation.title"
              @click="openRecentChat(conversation)"
            >
              <Icon
                icon="lucide:history"
                class="h-3.5 w-3.5 shrink-0 text-ink-muted"
              />
              <span class="max-w-52 truncate">{{ conversation.title }}</span>
            </button>
          </div>

          <div
            class="composer-spacer hidden md:block"
            aria-hidden="true"
          />
        </template>

        <!-- Incognito dims the whole new-chat view, centered composer included.
             Last child: the empty layout sizes the column's first child. -->
        <Transition
          enter-from-class="opacity-0"
          enter-active-class="transition-opacity duration-300 ease-out"
          leave-to-class="opacity-0"
          leave-active-class="transition-opacity duration-300 ease-in"
        >
          <div
            v-if="showCenteredComposer && chatStore.activeIsTemporary"
            class="chat-incognito-vignette pointer-events-none absolute inset-0 -z-10"
            aria-hidden="true"
          />
        </Transition>

        <div
          v-if="isDragOver"
          class="absolute inset-0 z-50 flex items-center justify-center bg-theme-900/80 border-2 border-dashed border-accent-500 rounded-lg pointer-events-none"
        >
          <div class="text-center">
            <div class="text-4xl mb-2">
              📎
            </div>
            <div class="text-accent-fg text-sm font-medium">
              Drop files here
            </div>
            <div class="text-ink-muted text-xs mt-1">
              Images &amp; text files supported
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-incognito-vignette {
  background: radial-gradient(ellipse at center, transparent 35%, color-mix(in oklab, var(--color-theme-950) 55%, transparent) 100%);
}

.chat-column > :deep(.chat-input-bar) {
  flex: 0 0 auto;
}

.composer-spacer {
  flex: 0 0 0;
  min-height: 0;
  transition: flex-grow 520ms cubic-bezier(0.22, 1, 0.36, 1);
}

.chat-column--empty .composer-spacer {
  flex-grow: 1;
}

/* While the composer is centered, park the context ring where it will sit once
   the composer docks (bottom-right of the column, matching the bar's px-4/py-3). */
.chat-column--empty > :deep(.chat-input-bar) {
  position: static;
}

.chat-column--empty :deep(.context-ring-anchor) {
  position: absolute;
  right: 1rem;
  bottom: 0.75rem;
}

.chat-column--empty > div:first-child {
  flex-grow: 1;
  flex-basis: 0;
}

.recent-agent-chat-pill {
  opacity: 0;
  animation: recent-chat-pill-in 420ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
}

@keyframes recent-chat-pill-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .composer-spacer {
    transition: none;
  }

  .recent-agent-chat-pill {
    opacity: 1;
    animation: none;
  }
}
</style>
