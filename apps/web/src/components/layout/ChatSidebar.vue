<script setup lang="ts">
import { ref, computed, watch } from 'vue'
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
const allSearchLoadToken = ref(0)

const ALL_PAGE_SIZE = 50

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
  await agentStore.restoreForConversation(conv.id)
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
  created_at: number
  updated_at: number
}): Conversation {
  return {
    id: row.id,
    title: row.title,
    agentId: row.agent_id,
    origin: row.origin,
    pinned: !!row.pinned,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

const allConversationsHasMore = computed(() => allConversations.value.length < allConversationsTotal.value)

async function loadMoreAllConversations(reset = false): Promise<void> {
  if (allConversationsLoading.value) return
  if (!reset && !allConversationsHasMore.value) return

  allConversationsLoading.value = true
  allConversationsError.value = null
  try {
    const offset = reset ? 0 : allConversations.value.length
    const res = await api.chat.listConversationsPaginated(ALL_PAGE_SIZE, offset)
    const page = res.items.map(mapConversationRow)
    if (reset) {
      allConversations.value = page
    } else {
      allConversations.value.push(...page)
    }
    allConversationsTotal.value = res.total
  } catch {
    allConversationsError.value = 'Failed to load conversations'
  } finally {
    allConversationsLoading.value = false
  }
}

async function loadAllPagesForSearch(token: number): Promise<void> {
  while (
    showAllConversations.value
    && searchQuery.value.trim().length > 0
    && allConversationsHasMore.value
    && token === allSearchLoadToken.value
  ) {
    await loadMoreAllConversations()
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
    await loadMoreAllConversations(true)
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
    ? sortPinnedFirst(allConversations.value)
    : chatStore.sortedConversations
))

const filteredConversations = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return visibleConversations.value
  return visibleConversations.value.filter(conv =>
    displayTitle(conv).toLowerCase().includes(q)
  )
})

watch(showAllConversations, (enabled) => {
  if (enabled) {
    void loadMoreAllConversations(true)
  }
})

watch(searchQuery, (query) => {
  if (!showAllConversations.value) return
  if (!query.trim()) return
  allSearchLoadToken.value += 1
  void loadAllPagesForSearch(allSearchLoadToken.value)
})
</script>

<template>
  <div class="w-64 bg-zinc-950 border-r border-zinc-800/60 flex flex-col shrink-0 h-full">
    <!-- Header -->
    <div class="px-3 py-2.5 border-b border-zinc-800/60 flex items-center justify-between">
      <span class="text-xs font-medium text-zinc-500 uppercase tracking-wider">Chat History</span>
      <button
        v-if="showAllConversations ? allConversations.length > 0 : chatStore.sortedConversations.length > 0"
        class="p-1 rounded-md text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
        title="Clear all history"
        @click="showClearConfirm = true"
      >
        <Icon
          icon="lucide:trash-2"
          class="w-3.5 h-3.5"
        />
      </button>
    </div>

    <!-- Search -->
    <div class="px-2 py-1.5 border-b border-zinc-800/60">
      <button
        class="w-full mb-2 rounded-lg border border-zinc-800 bg-zinc-900/70 p-0.5 grid grid-cols-2 text-[11px]"
        type="button"
        :aria-label="showAllConversations ? 'Showing all conversations' : 'Showing current conversations'"
      >
        <span
          class="rounded-md px-2 py-1 transition-colors"
          :class="showAllConversations ? 'text-zinc-500 hover:text-zinc-300' : 'bg-zinc-700 text-zinc-100'"
          @click="showAllConversations = false"
        >
          Current
        </span>
        <span
          class="rounded-md px-2 py-1 transition-colors"
          :class="showAllConversations ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'"
          @click="showAllConversations = true"
        >
          All
        </span>
      </button>

      <div class="relative">
        <Icon
          icon="lucide:search"
          class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500"
        />
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Search chats…"
          class="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-8 pr-7 py-1.5 text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
        >
        <button
          v-if="searchQuery"
          class="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
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
        class="group flex items-center px-3 py-2.5 mx-2 my-0.5 rounded-lg cursor-pointer transition-colors hover:bg-zinc-800/60"
        :class="{ 'bg-zinc-800': conv.id === chatStore.activeConversationId }"
        @click="selectChat(conv)"
      >
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1.5">
            <Icon
              v-if="conv.pinned"
              icon="lucide:pin"
              class="w-3 h-3 shrink-0 text-amber-400"
            />
            <span
              class="text-xs truncate"
              :class="
                conv.id === chatStore.activeConversationId ? 'text-zinc-100' : 'text-zinc-400'
              "
            >
              {{ displayTitle(conv) }}
            </span>
            <span
              v-if="agentStore.awaitingHITLConvIds.has(conv.id)"
              class="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0"
              title="Awaiting tool confirmation"
            />
            <span
              v-if="conv.origin && conv.origin !== 'chat'"
              class="shrink-0 text-[9px] font-medium px-1.5 py-0.5 rounded-full"
              :class="{
                'bg-purple-500/10 text-purple-400': conv.origin === 'channel',
                'bg-zinc-700/50 text-zinc-400': conv.origin !== 'channel'
              }"
            >
              {{ conv.origin }}
            </span>
          </div>
          <div class="text-xs text-zinc-600 mt-0.5">
            {{ formatDate(conv.updatedAt) }}
          </div>
        </div>
        <button
          class="opacity-0 group-hover:opacity-100 p-1 transition-all"
          :class="conv.pinned ? 'text-amber-400 hover:text-amber-300' : 'text-zinc-500 hover:text-amber-400'"
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
          class="opacity-0 group-hover:opacity-100 p-1 text-zinc-500 hover:text-red-400 transition-all"
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
        class="px-4 py-8 text-center text-zinc-600 text-sm"
      >
        {{ searchQuery ? 'No matching conversations' : 'No conversations yet' }}
      </div>

      <div
        v-if="showAllConversations && allConversationsLoading"
        class="px-4 py-2 text-center text-zinc-500 text-xs"
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
      <p class="text-zinc-400 leading-relaxed">
        Are you sure you want to delete all conversations for <strong class="text-zinc-200">{{ clearLabel }}</strong>? This action cannot be undone. Pinned conversations will be kept.
      </p>
      <template #actions>
        <button
          class="w-full px-4 py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl text-center font-medium transition-colors"
          @click="clearHistory"
        >
          Delete All
        </button>
        <button
          class="w-full px-4 py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl text-center font-medium transition-colors"
          @click="showClearConfirm = false"
        >
          Cancel
        </button>
      </template>
    </ModalDialog>
  </div>
</template>
