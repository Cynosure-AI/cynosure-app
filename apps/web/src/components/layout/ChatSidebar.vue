<script setup lang="ts">
import { ref, computed, onBeforeUnmount, watch } from 'vue'
import { api } from '../../api/client'
import { useChatStore, type Conversation } from '../../stores/chat.store'
import { useAgentStore } from '../../stores/agent-runtime.store'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import { Icon } from '@iconify/vue'
import ModalDialog from '../shared/ModalDialog.vue'

const chatStore = useChatStore()
const agentStore = useAgentStore()
const agentDefs = useAgentDefinitionsStore()
const showClearConfirm = ref(false)
const searchQuery = ref('')
const showAllConversations = ref(false)
const allConversations = ref<Conversation[]>([])
const allConversationsTotal = ref(0)
const allConversationsLoading = ref(false)
const allConversationsError = ref<string | null>(null)
const allConversationsQuery = ref('')
const allConversationsRequestToken = ref(0)
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null

const ALL_PAGE_SIZE = 50
const MIN_SEARCH_CHARS = 2
const SEARCH_DEBOUNCE_MS = 250

function sortPinnedFirst(items: Conversation[]): Conversation[] {
  return [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.updatedAt - a.updatedAt
  })
}

const clearLabel = computed(() => {
  if (showAllConversations.value) {
    return 'this app'
  }
  if (chatStore.activeAgentId) {
    const agent = agentDefs.get(chatStore.activeAgentId)
    return agent?.name || 'this agent'
  }
  return 'Default'
})
async function selectChat(conv: Conversation): Promise<void> {
  await chatStore.selectConversation(conv.id, conv.agentId ?? null)
  conv.lastReadAt = Math.max(Date.now(), conv.updatedAt, conv.lastReadAt || 0)
}

async function deleteChat(id: string, event: Event): Promise<void> {
  event.stopPropagation()
  await chatStore.deleteConversation(id)
  if (showAllConversations.value) {
    const idx = allConversations.value.findIndex(conv => conv.id === id)
    if (idx >= 0) {
      allConversations.value.splice(idx, 1)
      allConversationsTotal.value = Math.max(0, allConversationsTotal.value - 1)
    }
  }
}

async function togglePin(id: string, pinned: boolean, event: Event): Promise<void> {
  event.stopPropagation()
  await chatStore.pinConversation(id, !pinned)
  if (showAllConversations.value) {
    const conv = allConversations.value.find(c => c.id === id)
    if (conv) {
      conv.pinned = !pinned
      conv.updatedAt = Date.now()
      allConversations.value = sortPinnedFirst(allConversations.value)
    }
  }
}

function mapConversationRow(row: {
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
    pinned: !!row.pinned,
    lastReadAt: row.last_read_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

const allConversationsHasMore = computed(() => allConversations.value.length < allConversationsTotal.value)

function normalizedAllSearchQuery(): string {
  const query = searchQuery.value.trim()
  return query.length >= MIN_SEARCH_CHARS ? query : ''
}

function clearPendingSearchLoad(): void {
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
    searchDebounceTimer = null
  }
}

function clearAllConversationResults(): void {
  allConversationsRequestToken.value += 1
  allConversationsQuery.value = ''
  allConversations.value = []
  allConversationsTotal.value = 0
  allConversationsLoading.value = false
  allConversationsError.value = null
}

async function loadMoreAllConversations(reset = false, query = allConversationsQuery.value): Promise<void> {
  const normalizedQuery = query.trim()
  if (allConversationsLoading.value && !reset) return
  if (!reset && !allConversationsHasMore.value) return
  if (reset) {
    allConversationsRequestToken.value += 1
    allConversationsQuery.value = normalizedQuery
    allConversations.value = []
    allConversationsTotal.value = 0
  }

  const requestToken = allConversationsRequestToken.value
  allConversationsLoading.value = true
  allConversationsError.value = null
  try {
    const offset = reset ? 0 : allConversations.value.length
    const res = await api.chat.listConversationsPaginated(
      ALL_PAGE_SIZE,
      offset,
      undefined,
      normalizedQuery || undefined
    )
    if (requestToken !== allConversationsRequestToken.value || normalizedQuery !== allConversationsQuery.value) return
    const page = res.items.map(mapConversationRow)
    if (reset) {
      allConversations.value = page
    } else {
      allConversations.value.push(...page)
    }
    allConversationsTotal.value = res.total
  } catch {
    if (requestToken !== allConversationsRequestToken.value) return
    allConversationsError.value = 'Failed to load conversations'
  } finally {
    if (requestToken === allConversationsRequestToken.value) {
      allConversationsLoading.value = false
    }
  }
}

function onConversationListScroll(event: Event): void {
  if (!showAllConversations.value || allConversationsLoading.value || !allConversationsHasMore.value) return
  const target = event.target as HTMLElement
  const threshold = 120
  if (target.scrollHeight - target.scrollTop - target.clientHeight <= threshold) {
    void loadMoreAllConversations()
  }
}

async function clearHistory(): Promise<void> {
  await chatStore.deleteAllConversations(showAllConversations.value)
  if (showAllConversations.value) {
    await loadMoreAllConversations(true, normalizedAllSearchQuery())
  }
  showClearConfirm.value = false
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** Transform raw channel conversation titles into readable labels. */
function displayTitle(conv: { title: string; origin?: string }): string {
  if (conv.origin === 'channel') {
    const prefixes: Record<string, string> = { 'telegram:': 'Telegram', 'discord:': 'Discord', 'slack:': 'Slack' }
    for (const [prefix, label] of Object.entries(prefixes)) {
      if (conv.title.startsWith(prefix)) {
        const parts = conv.title.split('|')
        const senderName = parts[1] || 'Chat'
        const archivePart = parts.find(p => p.startsWith('archived:'))
        if (archivePart) {
          const ts = parseInt(archivePart.split(':')[1])
          return `${label}: ${senderName} · ${formatDate(ts)}`
        }
        return `${label}: ${senderName}`
      }
    }
  }
  return conv.title
}

const visibleConversations = computed(() => (
  showAllConversations.value
    ? allConversations.value
    : chatStore.sortedConversations
))

const filteredConversations = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (showAllConversations.value) {
    if (q.length > 0 && q.length < MIN_SEARCH_CHARS) return []
    return visibleConversations.value
  }
  if (!q) return visibleConversations.value
  return visibleConversations.value.filter(conv =>
    displayTitle(conv).toLowerCase().includes(q)
  )
})

const emptyConversationsMessage = computed(() => {
  if (showAllConversations.value && searchQuery.value.trim().length > 0 && searchQuery.value.trim().length < MIN_SEARCH_CHARS) {
    return `Type at least ${MIN_SEARCH_CHARS} characters`
  }
  return searchQuery.value ? 'No matching conversations' : 'No conversations yet'
})

const hasUnread = computed(() => visibleConversations.value.some(c => chatStore.isConversationUnread(c)))

watch(showAllConversations, (enabled) => {
  clearPendingSearchLoad()
  if (enabled) {
    const query = searchQuery.value.trim()
    if (query.length > 0 && query.length < MIN_SEARCH_CHARS) {
      clearAllConversationResults()
      return
    }
    void loadMoreAllConversations(true, normalizedAllSearchQuery())
  }
})

watch(searchQuery, (query) => {
  if (!showAllConversations.value) return
  clearPendingSearchLoad()
  const trimmed = query.trim()
  if (trimmed.length > 0 && trimmed.length < MIN_SEARCH_CHARS) {
    clearAllConversationResults()
    return
  }
  searchDebounceTimer = setTimeout(() => {
    void loadMoreAllConversations(true, normalizedAllSearchQuery())
  }, SEARCH_DEBOUNCE_MS)
})

onBeforeUnmount(() => {
  clearPendingSearchLoad()
  allConversationsRequestToken.value += 1
})
</script>

<template>
  <div class="w-64 bg-theme-950 bg-sidebar-chat border-r border-theme-800/60 flex flex-col shrink-0 h-full">
    <!-- Header -->
    <div class="px-3 py-2.5 border-b border-theme-800/60 flex items-center justify-between">
      <span class="text-xs font-medium text-theme-500 uppercase tracking-wider">Chat History</span>
      <div class="flex items-center gap-0.5">
        <button
          v-if="hasUnread"
          class="p-1 rounded-md text-theme-600 hover:text-accent-400 hover:bg-accent-500/10 transition-colors"
          title="Mark all as read"
          @click="chatStore.markAllAsRead()"
        >
          <Icon
            icon="lucide:check-check"
            class="w-3.5 h-3.5"
          />
        </button>
        <button
          v-if="showAllConversations ? allConversations.length > 0 : chatStore.sortedConversations.length > 0"
          class="p-1 rounded-md text-theme-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
          title="Clear all history"
          @click="showClearConfirm = true"
        >
          <Icon
            icon="lucide:trash-2"
            class="w-3.5 h-3.5"
          />
        </button>
      </div>
    </div>

    <!-- Search -->
    <div class="px-2 py-1.5 border-b border-theme-800/60">
      <button
        class="w-full mb-2 rounded-lg border border-theme-800 bg-theme-900/70 p-0.5 grid grid-cols-2 text-[11px]"
        type="button"
        :aria-label="showAllConversations ? 'Showing all conversations' : 'Showing current conversations'"
      >
        <span
          class="rounded-md px-2 py-1 transition-colors"
          :class="showAllConversations ? 'text-theme-500 hover:text-theme-300' : 'bg-theme-700 text-theme-100'"
          @click="showAllConversations = false"
        >
          Current
        </span>
        <span
          class="rounded-md px-2 py-1 transition-colors"
          :class="showAllConversations ? 'bg-theme-700 text-theme-100' : 'text-theme-500 hover:text-theme-300'"
          @click="showAllConversations = true"
        >
          All
        </span>
      </button>

      <div class="relative">
        <Icon
          icon="lucide:search"
          class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-theme-500"
        />
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Search chats…"
          class="w-full bg-theme-900 border border-theme-800 rounded-lg pl-8 pr-7 py-1.5 text-xs text-theme-300 placeholder:text-theme-600 focus:outline-none focus:border-theme-600 transition-colors"
        >
        <button
          v-if="searchQuery"
          class="absolute right-2 top-1/2 -translate-y-1/2 text-theme-500 hover:text-theme-300 transition-colors"
          @click="searchQuery = ''"
        >
          <Icon
            icon="lucide:x"
            class="w-3.5 h-3.5"
          />
        </button>
      </div>
    </div>

    <!-- Conversation list -->
    <div
      class="flex-1 overflow-y-auto"
      @scroll.passive="onConversationListScroll"
    >
      <div
        v-for="conv in filteredConversations"
        :key="conv.id"
        class="group flex items-center px-3 py-2.5 mx-2 my-0.5 rounded-lg cursor-pointer transition-colors hover:bg-theme-800/60"
        :class="{ 'bg-theme-800': conv.id === chatStore.activeConversationId }"
        @click="selectChat(conv)"
      >
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1.5">
            <span
              v-if="chatStore.isConversationUnread(conv)"
              class="w-2 h-2 rounded-full bg-accent-400 shrink-0"
              title="Unread"
            />
            <Icon
              v-if="conv.pinned"
              icon="lucide:pin"
              class="w-3 h-3 shrink-0 text-amber-400"
            />
            <span
              class="text-xs truncate"
              :class="
                conv.id === chatStore.activeConversationId ? 'text-theme-100' : 'text-theme-400'
              "
            >
              {{ displayTitle(conv) }}
            </span>
            <span
              v-if="agentStore.awaitingHITLConvIds.has(conv.id)"
              class="relative inline-flex h-4 w-4 shrink-0 items-center justify-center text-accent-400"
              title="Awaiting tool confirmation"
            >
              <span class="absolute inline-flex h-full w-full rounded-full bg-accent-400/40 animate-ping" />
              <Icon
                icon="lucide:info"
                class="relative h-3.5 w-3.5"
              />
            </span>
            <span
              v-if="conv.origin && conv.origin !== 'chat'"
              class="shrink-0 text-[9px] font-medium px-1.5 py-0.5 rounded-full"
              :class="{
                'bg-purple-500/10 text-purple-400': conv.origin === 'channel',
                'bg-theme-700/50 text-theme-400': conv.origin !== 'channel'
              }"
            >
              {{ conv.origin }}
            </span>
          </div>
          <div class="text-xs text-theme-600 mt-0.5">
            {{ formatDate(conv.updatedAt) }}
          </div>
        </div>
        <button
          class="opacity-0 group-hover:opacity-100 p-1 transition-all"
          :class="conv.pinned ? 'text-amber-400 hover:text-amber-300' : 'text-theme-500 hover:text-amber-400'"
          :title="conv.pinned ? 'Unpin conversation' : 'Pin conversation'"
          @click="togglePin(conv.id, conv.pinned, $event)"
        >
          <Icon
            :icon="conv.pinned ? 'lucide:pin-off' : 'lucide:pin'"
            class="w-3.5 h-3.5"
          />
        </button>
        <button
          v-if="!conv.pinned"
          class="opacity-0 group-hover:opacity-100 p-1 text-theme-500 hover:text-red-400 transition-all"
          @click="deleteChat(conv.id, $event)"
        >
          <Icon
            icon="lucide:x"
            class="w-3.5 h-3.5"
          />
        </button>
      </div>

      <div
        v-if="filteredConversations.length === 0"
        class="px-4 py-8 text-center text-theme-600 text-sm"
      >
        {{ emptyConversationsMessage }}
      </div>

      <div
        v-if="showAllConversations && allConversationsLoading"
        class="px-4 py-2 text-center text-theme-500 text-xs"
      >
        Loading more...
      </div>
      <div
        v-else-if="showAllConversations && allConversationsError"
        class="px-4 py-2 text-center text-red-400 text-xs"
      >
        {{ allConversationsError }}
      </div>
    </div>

    <!-- Clear All Confirmation -->
    <ModalDialog
      :show="showClearConfirm"
      title="Clear Chat History"
      icon="lucide:trash-2"
      icon-color="red"
      @close="showClearConfirm = false"
    >
      <p class="text-theme-400 leading-relaxed">
        Are you sure you want to delete all conversations for <strong class="text-theme-200">{{ clearLabel }}</strong>? This action cannot be undone. Pinned conversations will be kept.
      </p>
      <template #actions>
        <button
          class="w-full px-4 py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl text-center font-medium transition-colors"
          @click="clearHistory"
        >
          Delete All
        </button>
        <button
          class="w-full px-4 py-3 bg-theme-800 hover:bg-theme-700 text-theme-300 rounded-xl text-center font-medium transition-colors"
          @click="showClearConfirm = false"
        >
          Cancel
        </button>
      </template>
    </ModalDialog>
  </div>
</template>
