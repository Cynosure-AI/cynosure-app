<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import { api } from '../../api/client'
import { wsConnected } from '../../api/http'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import { useAgentStore } from '../../stores/agent-runtime.store'
import { useChatStore, type Conversation } from '../../stores/chat.store'

const props = withDefaults(defineProps<{
  awaitingConversationIds?: string[]
  activeConversationIds?: string[]
  agentId?: string | null
}>(), {
  awaitingConversationIds: () => [],
  activeConversationIds: () => [],
  agentId: undefined,
})

const router = useRouter()
const chatStore = useChatStore()
const agentStore = useAgentStore()
const agentDefs = useAgentDefinitionsStore()
const conversations = ref<Conversation[]>([])
const total = ref(0)
const loading = ref(false)
const loadError = ref(false)
const searchQuery = ref('')
const activeQuery = ref('')
const requestToken = ref(0)
const openMenuId = ref<string | null>(null)
const editingId = ref<string | null>(null)
const editingTitle = ref('')
const titleInputRef = ref<HTMLInputElement | null>(null)
let searchTimer: ReturnType<typeof setTimeout> | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryDelay = 500
let disposed = false
const liveCleanups: Array<() => void> = []

const PAGE_SIZE = 50
const MIN_SEARCH_LENGTH = 2
const MAX_RETRY_DELAY = 5_000
const awaitingIds = computed(() => new Set([
  ...props.awaitingConversationIds,
  ...agentStore.awaitingHITLConvIds,
]))
const runningIds = computed(() => {
  const ids = new Set([
    ...props.activeConversationIds,
    ...agentStore.liveExecutionConversationIds,
  ])
  if (chatStore.activeConversationIsStreaming && chatStore.activeConversationId) {
    ids.add(chatStore.activeConversationId)
  }
  return ids
})

function ordered(items: Conversation[]): Conversation[] {
  return [...items].sort((a, b) => {
    const aHitl = awaitingIds.value.has(a.id)
    const bHitl = awaitingIds.value.has(b.id)
    if (aHitl !== bHitl) return aHitl ? -1 : 1
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.updatedAt - a.updatedAt
  })
}

const visibleConversations = computed(() => {
  const merged = new Map(conversations.value.map((conversation) => [conversation.id, conversation]))
  // The chat store is scoped to the active agent, so only use it as an
  // optimistic source when the sidebar is explicitly filtered to that agent.
  // Merging it into the default view makes agent-only chats flash before the
  // global sidebar query has returned.
  if (!activeQuery.value && props.agentId !== undefined) {
    for (const conversation of chatStore.conversations) {
      if ((conversation.agentId ?? null) !== props.agentId) continue
      merged.set(conversation.id, conversation)
    }
  }
  return ordered([...merged.values()])
})
const hasMore = computed(() => conversations.value.length < total.value)

function mapRow(row: {
  id: string
  title: string
  agent_id: string | null
  origin: string
  pinned: number
  last_read_at: number | null
  created_at: number
  updated_at: number
}): Conversation {
  return {
    id: row.id,
    title: row.title,
    agentId: row.agent_id,
    origin: row.origin,
    pinned: Boolean(row.pinned),
    lastReadAt: row.last_read_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function load(reset = false, clearExisting = false): Promise<void> {
  if (loading.value && !reset) return
  if (!reset && !hasMore.value) return

  if (reset) {
    requestToken.value += 1
    if (clearExisting) {
      conversations.value = []
      total.value = 0
    }
  }
  const token = requestToken.value
  loading.value = true
  loadError.value = false
  try {
    const response = await api.chat.listConversationsPaginated(
      PAGE_SIZE,
      reset ? 0 : conversations.value.length,
      'sidebar',
      activeQuery.value || undefined,
      props.agentId,
    )
    if (token !== requestToken.value) return
    const rows = response.items.map(mapRow)
    conversations.value = reset ? rows : [...conversations.value, ...rows]
    total.value = response.total
    retryDelay = 500
    clearRetry()
  } catch {
    if (token === requestToken.value) {
      loadError.value = true
      scheduleRetry()
    }
  } finally {
    if (token === requestToken.value) loading.value = false
  }
}

function clearRetry(): void {
  if (!retryTimer) return
  clearTimeout(retryTimer)
  retryTimer = null
}

function scheduleRetry(): void {
  if (disposed || retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    if (!disposed) void load(true)
  }, retryDelay)
  retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY)
}

function onScroll(event: Event): void {
  const element = event.target as HTMLElement
  if (element.scrollHeight - element.scrollTop - element.clientHeight < 100) void load()
}

async function selectConversation(conversation: Conversation): Promise<void> {
  openMenuId.value = null
  await chatStore.selectConversation(conversation.id, conversation.agentId ?? null)
  await router.push({ name: 'conversation', params: { conversationId: conversation.id } })
}

async function togglePin(conversation: Conversation, event: Event): Promise<void> {
  event.stopPropagation()
  openMenuId.value = null
  await chatStore.pinConversation(conversation.id, !conversation.pinned)
  conversation.pinned = !conversation.pinned
}

function startRename(conversation: Conversation, event: Event): void {
  event.stopPropagation()
  openMenuId.value = null
  editingId.value = conversation.id
  editingTitle.value = conversation.title
  void nextTick(() => titleInputRef.value?.select())
}

async function commitRename(conversation: Conversation): Promise<void> {
  if (editingId.value !== conversation.id) return
  const title = editingTitle.value.trim()
  editingId.value = null
  if (!title || title === conversation.title) return
  await chatStore.renameConversation(conversation.id, title)
  conversation.title = title
}

async function deleteConversation(conversation: Conversation, event: Event): Promise<void> {
  event.stopPropagation()
  openMenuId.value = null
  await chatStore.deleteConversation(conversation.id)
  conversations.value = conversations.value.filter((item) => item.id !== conversation.id)
  total.value = Math.max(0, total.value - 1)
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function agentName(conversation: Conversation): string {
  return conversation.agentId ? agentDefs.get(conversation.agentId)?.name || 'Agent' : 'Free Chat'
}

function closeMenu(): void {
  openMenuId.value = null
}

function openContextMenu(conversationId: string, event: MouseEvent): void {
  event.stopPropagation()
  editingId.value = null
  openMenuId.value = conversationId
}

function scheduleRefresh(): void {
  if (activeQuery.value) return
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => void load(true), 200)
}

watch(searchQuery, (query) => {
  if (searchTimer) clearTimeout(searchTimer)
  const trimmed = query.trim()
  if (trimmed.length > 0 && trimmed.length < MIN_SEARCH_LENGTH) {
    clearRetry()
    requestToken.value += 1
    activeQuery.value = trimmed
    conversations.value = []
    total.value = 0
    loading.value = false
    loadError.value = false
    return
  }
  searchTimer = setTimeout(() => {
    activeQuery.value = trimmed
    void load(true, true)
  }, 250)
})

watch(() => props.agentId, () => {
  void load(true, true)
})

watch(() => chatStore.activeConversationId, (conversationId) => {
  if (conversationId) scheduleRefresh()
})

watch(() => props.activeConversationIds.join('|'), scheduleRefresh)

watch(wsConnected, (connected) => {
  if (!connected || !loadError.value) return
  clearRetry()
  retryDelay = 500
  void load(true)
})

onMounted(() => {
  disposed = false
  document.addEventListener('click', closeMenu)
  liveCleanups.push(
    api.chat.onNewMessage(scheduleRefresh),
    api.chat.onTitleUpdated(scheduleRefresh),
    api.chat.onChannelConversationState(scheduleRefresh),
    api.agent.onHITLRequest(scheduleRefresh),
  )
  void load(true)
})

onBeforeUnmount(() => {
  disposed = true
  if (searchTimer) clearTimeout(searchTimer)
  if (refreshTimer) clearTimeout(refreshTimer)
  clearRetry()
  requestToken.value += 1
  liveCleanups.forEach((cleanup) => cleanup())
  document.removeEventListener('click', closeMenu)
})
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="px-2 pb-2">
      <div class="relative">
        <Icon
          icon="lucide:search"
          class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-600"
        />
        <input
          v-model="searchQuery"
          type="search"
          :placeholder="agentId === undefined
            ? 'Filter all chats…'
            : agentId === null
              ? 'Filter Free Chat conversations…'
              : 'Filter this agent’s chats…'"
          aria-label="Filter recent chats"
          class="w-full rounded-lg border border-theme-800 bg-theme-900/70 py-1.5 pl-8 pr-3 text-xs text-theme-300 outline-none transition placeholder:text-theme-600 focus:border-theme-600"
        >
      </div>
    </div>

    <div
      class="min-h-0 flex-1 overflow-y-auto px-1"
      @scroll.passive="onScroll"
    >
      <div
        v-for="conversation in visibleConversations"
        :key="conversation.id"
        role="button"
        tabindex="0"
        class="group relative cursor-pointer mb-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition hover:bg-theme-800/70"
        :class="{
          'bg-theme-800': conversation.id === chatStore.activeConversationId,
          'bg-amber-500/10 ring-1 ring-inset ring-amber-500/20': awaitingIds.has(conversation.id),
        }"
        @click="selectConversation(conversation)"
        @contextmenu.prevent="openContextMenu(conversation.id, $event)"
        @keydown.enter.self.prevent="selectConversation(conversation)"
      >
        <span class="relative flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-theme-800 text-theme-500">
          <Icon
            v-if="runningIds.has(conversation.id)"
            icon="lucide:loader-circle"
            class="h-3.5 w-3.5 animate-spin text-accent-400"
          />
          <img
            v-else-if="conversation.agentId && agentDefs.get(conversation.agentId)?.iconUrl"
            :src="agentDefs.get(conversation.agentId)?.iconUrl || ''"
            :alt="`${agentName(conversation)} icon`"
            class="h-full w-full object-cover"
          >
          <Icon
            v-else
            :icon="conversation.agentId ? 'lucide:bot' : 'lucide:message-square'"
            class="h-3.5 w-3.5"
          />
          <span
            v-if="awaitingIds.has(conversation.id)"
            class="absolute bottom-0 right-0 h-2 w-2 rounded-full bg-amber-400 ring-2 ring-theme-900"
            title="Waiting for your approval"
          />
        </span>

        <span class="min-w-0 flex-1">
          <span class="flex min-w-0 items-center gap-1">
            <Icon
              v-if="conversation.pinned"
              icon="lucide:pin"
              class="h-3 w-3 shrink-0 text-amber-400"
            />
            <input
              v-if="editingId === conversation.id"
              ref="titleInputRef"
              v-model="editingTitle"
              class="min-w-0 flex-1 rounded border border-theme-600 bg-theme-900 px-1 py-0.5 text-xs text-theme-100 outline-none"
              aria-label="Conversation title"
              @click.stop
              @blur="commitRename(conversation)"
              @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
              @keydown.escape.prevent="editingId = null"
            >
            <span
              v-else
              class="truncate text-xs text-theme-300"
            >{{ conversation.title }}</span>
          </span>
          <span class="mt-0.5 flex items-center gap-1 truncate text-[10px] text-theme-600">
            <span class="truncate">{{ agentName(conversation) }}</span>
            <span>·</span>
            <span class="shrink-0">{{ formatDate(conversation.updatedAt) }}</span>
          </span>
        </span>

        <span class="relative shrink-0">
          <button
            type="button"
            class="rounded-md p-1 text-theme-500 opacity-0 transition hover:bg-theme-700 hover:text-theme-200 group-hover:opacity-100 focus-visible:opacity-100"
            :class="{ 'bg-theme-700 text-theme-200 opacity-100': openMenuId === conversation.id }"
            aria-label="Chat options"
            @click.stop="openMenuId = openMenuId === conversation.id ? null : conversation.id"
          >
            <Icon
              icon="lucide:ellipsis"
              class="h-3.5 w-3.5"
            />
          </button>
          <span
            v-if="openMenuId === conversation.id"
            class="absolute right-0 top-7 z-30 w-36 overflow-hidden rounded-lg border border-theme-700 bg-theme-900 py-1 shadow-xl"
            @click.stop
          >
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3 py-2 text-xs text-theme-300 hover:bg-theme-800"
              @click="togglePin(conversation, $event)"
            >
              <Icon
                :icon="conversation.pinned ? 'lucide:pin-off' : 'lucide:pin'"
                class="h-3.5 w-3.5 text-amber-400"
              />
              {{ conversation.pinned ? 'Unpin' : 'Pin' }}
            </button>
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3 py-2 text-xs text-theme-300 hover:bg-theme-800"
              @click="startRename(conversation, $event)"
            >
              <Icon
                icon="lucide:pencil"
                class="h-3.5 w-3.5"
              /> Rename
            </button>
            <button
              type="button"
              class="flex w-full items-center gap-2 border-t border-theme-800 px-3 py-2 text-xs text-red-300 hover:bg-red-500/10"
              @click="deleteConversation(conversation, $event)"
            >
              <Icon
                icon="lucide:trash-2"
                class="h-3.5 w-3.5"
              /> Delete
            </button>
          </span>
        </span>
      </div>

      <p
        v-if="!visibleConversations.length && !loading"
        class="px-3 py-6 text-center text-xs text-theme-600"
      >
        {{ searchQuery.trim().length === 1 ? 'Type at least 2 characters' : searchQuery ? 'No matching chats' : 'No recent chats' }}
      </p>
      <p
        v-if="loading && !visibleConversations.length"
        class="px-3 py-2 text-center text-[10px] text-theme-600"
      >
        Loading chats…
      </p>
      <p
        v-if="loadError"
        class="flex items-center justify-center gap-1.5 px-3 py-2 text-center text-xs text-theme-500"
      >
        <Icon
          icon="lucide:loader-circle"
          class="h-3.5 w-3.5 animate-spin"
        />
        Connecting to chats…
      </p>
    </div>
  </div>
</template>
