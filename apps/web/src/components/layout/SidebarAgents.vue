<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'

import { api, type ConversationRow } from '../../api/client'
import { wsConnected } from '../../api/http'
import { useChatStore } from '../../stores/chat.store'
import { useAgentStore } from '../../stores/agent-runtime.store'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import { useCynoStore } from '../../stores/cyno.store'
import { useProviderStore } from '../../stores/provider.store'
import type { AvatarConfig } from '../../utils/avatar'
import AgentAvatar from '../shared/AgentAvatar.vue'
import HoverTooltip from '../shared/HoverTooltip.vue'

/** Recent chats scanned to order agents by last use and to place live chats under them. */
const RECENT_SCAN_SIZE = 200
const INITIAL_CHATS = 5
const MORE_CHATS_PAGE_SIZE = 20
/** Cyno's chats have no agent id; the API takes an empty string for them. */
const CYNO_KEY = ''

type AgentChats = {
  items: ConversationRow[]
  total: number
  loading: boolean
}

type AgentEntry = {
  key: string
  name: string
  iconUrl: string | null
  avatar: AvatarConfig | null
  pending: boolean
  favorite: boolean
  lastUsedAt: number
}

const props = withDefaults(defineProps<{
  collapsed?: boolean
  activeConversationIds?: string[]
  awaitingConversationIds?: string[]
  filters?: string[]
  /** Leave out chats that belong to a project; they are listed under their project. */
  excludeProjectChats?: boolean
}>(), {
  collapsed: false,
  activeConversationIds: () => [],
  awaitingConversationIds: () => [],
  filters: () => ['all'],
})

const route = useRoute()
const router = useRouter()
const chatStore = useChatStore()
const agentStore = useAgentStore()
const agentDefs = useAgentDefinitionsStore()
const cyno = useCynoStore()
const providerStore = useProviderStore()

const recentChats = ref<ConversationRow[]>([])
const recentLoaded = ref(false)
const chatsByAgent = ref<Record<string, AgentChats>>({})
const expanded = ref(new Set<string>())
const openMenuId = ref<string | null>(null)
const openAgentMenuKey = ref<string | null>(null)
const agentMenuRef = ref<HTMLElement | null>(null)
const editingId = ref<string | null>(null)
const editingTitle = ref('')
const titleInputRef = ref<HTMLInputElement | null>(null)
let refreshTimer: ReturnType<typeof setTimeout> | undefined
let recentToken = 0
const liveCleanups: Array<() => void> = []

const filterAll = computed(() => !props.filters.length || props.filters.includes('all'))

function keyOf(agentId: string | null | undefined): string {
  return agentId ?? CYNO_KEY
}

const lastUsedByAgent = computed(() => {
  const latest = new Map<string, number>()
  for (const chat of recentChats.value) {
    const key = keyOf(chat.agent_id)
    latest.set(key, Math.max(latest.get(key) ?? 0, chat.updated_at))
  }
  return latest
})

// Every agent: favorites first, then most recently used; unused ones follow by name.
// A narrowed filter lists only the agents that have matching chats.
const agents = computed<AgentEntry[]>(() => {
  const entries: AgentEntry[] = [
    {
      key: CYNO_KEY,
      name: cyno.name,
      iconUrl: cyno.displayIconUrl,
      avatar: cyno.avatar,
      pending: !cyno.profile,
      favorite: false,
      lastUsedAt: lastUsedByAgent.value.get(CYNO_KEY) ?? 0,
    },
    ...agentDefs.agents.map((agent) => ({
      key: agent.id,
      name: agent.name,
      iconUrl: agent.iconUrl,
      avatar: agent.avatar,
      pending: false,
      favorite: agent.favorite,
      lastUsedAt: lastUsedByAgent.value.get(agent.id) ?? 0,
    })),
  ]
  return entries
    .filter((entry) => filterAll.value || entry.lastUsedAt > 0)
    .sort((a, b) =>
      Number(b.favorite) - Number(a.favorite) ||
      (b.lastUsedAt - a.lastUsedAt) ||
      a.name.localeCompare(b.name))
})

const menuAgent = computed(() => agents.value.find((entry) => entry.key === openAgentMenuKey.value))

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

const awaitingIds = computed(() => new Set([
  ...props.awaitingConversationIds,
  ...agentStore.awaitingHITLConvIds,
]))

function agentKeysWith(conversationIds: Set<string>): Set<string> {
  const keys = new Set<string>()
  for (const chat of recentChats.value) {
    if (conversationIds.has(chat.id)) keys.add(keyOf(chat.agent_id))
  }
  for (const [key, chats] of Object.entries(chatsByAgent.value)) {
    if (chats.items.some((chat) => conversationIds.has(chat.id))) keys.add(key)
  }
  return keys
}

const runningAgentKeys = computed(() => agentKeysWith(runningIds.value))
const awaitingAgentKeys = computed(() => agentKeysWith(awaitingIds.value))
const waitingAgentKeys = computed(() => {
  const keys = new Set<string>()
  const chats = [...recentChats.value, ...Object.values(chatsByAgent.value).flatMap((group) => group.items)]
  for (const chat of chats) {
    if (isWaiting(chat)) keys.add(keyOf(chat.agent_id))
  }
  return keys
})

/** The agent of the open chat, or of the fresh chat being started on /chat. */
const activeAgentKey = computed(() => {
  const id = chatStore.activeConversationId
  if (!id) return route.name === 'triggers-chat' ? keyOf(chatStore.activeAgentId) : null
  const chat = recentChats.value.find((item) => item.id === id) ??
    Object.values(chatsByAgent.value).flatMap((chats) => chats.items).find((item) => item.id === id)
  return chat ? keyOf(chat.agent_id) : null
})

/** Waiting for a scheduled wait to resume it, and not doing anything else meanwhile. */
function isWaiting(chat: ConversationRow): boolean {
  return Boolean(chat.wait_until) && !runningIds.value.has(chat.id)
}

function resumeLabel(chat: ConversationRow): string {
  return `Waiting. Resumes at ${new Date(chat.wait_until!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

// Data
function listChats(key: string, limit: number, offset: number, sort: 'updated' | 'sidebar' = 'sidebar') {
  return api.chat.listConversationsPaginated(
    limit,
    offset,
    sort,
    undefined,
    key === CYNO_KEY ? null : key,
    props.filters,
    { excludeProjects: props.excludeProjectChats },
  )
}

async function loadRecent(): Promise<void> {
  const token = ++recentToken
  try {
    const { items } = await api.chat.listConversationsPaginated(
      RECENT_SCAN_SIZE,
      0,
      'updated',
      undefined,
      undefined,
      props.filters,
      { excludeProjects: props.excludeProjectChats },
    )
    if (token !== recentToken) return
    recentChats.value = items
    recentLoaded.value = true
  } catch {
    // Keep the last known order until the next refresh.
  }
}

/** Reloads an agent's chats, keeping as many rows as are already shown. */
async function loadChats(key: string): Promise<void> {
  const current = chatsByAgent.value[key]
  const limit = Math.max(INITIAL_CHATS, current?.items.length ?? 0)
  try {
    const { items, total } = await listChats(key, limit, 0)
    chatsByAgent.value = { ...chatsByAgent.value, [key]: { items, total, loading: false } }
  } catch {
    // Keep cached chats until the next refresh.
  }
}

async function loadMore(key: string): Promise<void> {
  const current = chatsByAgent.value[key]
  if (!current || current.loading) return
  current.loading = true
  try {
    const { items, total } = await listChats(key, MORE_CHATS_PAGE_SIZE, current.items.length)
    const known = new Set(current.items.map((chat) => chat.id))
    current.items = [...current.items, ...items.filter((chat) => !known.has(chat.id))]
    current.total = total
  } catch {
    // The button stays so the user can try again.
  } finally {
    current.loading = false
  }
}

function refresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined
    void loadRecent()
    for (const key of expanded.value) void loadChats(key)
  }, 200)
}

// Expand/collapse animation: height runs between 0 and the measured content height.
function expandHeight(el: Element): void {
  const list = el as HTMLElement
  list.style.height = '0px'
  void list.offsetHeight
  list.style.height = `${list.scrollHeight}px`
}

function collapseHeight(el: Element): void {
  const list = el as HTMLElement
  list.style.height = `${list.scrollHeight}px`
  void list.offsetHeight
  list.style.height = '0px'
}

function clearHeight(el: Element): void {
  (el as HTMLElement).style.height = ''
}

function setExpanded(key: string, open: boolean): void {
  // One agent is open at a time, like projects.
  expanded.value = open ? new Set([key]) : new Set()
  if (open) void loadChats(key)
}

// Navigation and interaction
async function openChat(row: ConversationRow): Promise<void> {
  closeMenu()
  await chatStore.selectConversation(row.id, row.agent_id)
  await router.push({ name: 'conversation', params: { conversationId: row.id } })
}

/** Starts a fresh chat with the agent and shows its chats; a second click on the open agent folds them away. */
async function selectAgent(entry: AgentEntry): Promise<void> {
  closeMenu()
  if (
    !props.collapsed && expanded.value.has(entry.key) &&
    activeAgentKey.value === entry.key && !chatStore.activeConversationId
  ) {
    setExpanded(entry.key, false)
    return
  }
  if (!props.collapsed) setExpanded(entry.key, true)
  await startAgentChat(entry)
}

async function startAgentChat(entry: AgentEntry): Promise<void> {
  closeMenu()
  await chatStore.setActiveAgent(entry.key === CYNO_KEY ? null : entry.key)
  const providerId = entry.key !== CYNO_KEY ? agentDefs.get(entry.key)?.providerId : undefined
  if (providerId) providerStore.setLastUsed(providerId)
  await chatStore.startNewChat()
  await router.push({ name: 'triggers-chat' })
}

function closeMenu(): void {
  openMenuId.value = null
  openAgentMenuKey.value = null
}

// Keep menus outside the scroll area and flip them above rows near the bottom.
const MENU_WIDTH = 144
const MENU_HEIGHT = 112
const menuStyle = ref<Record<string, string>>({})

function placeMenu(left: number, anchorTop: number, anchorBottom: number, height = MENU_HEIGHT): void {
  const fitsBelow = anchorBottom + 4 + height <= window.innerHeight - 8
  const top = fitsBelow ? anchorBottom + 4 : Math.max(8, anchorTop - 4 - height)
  menuStyle.value = {
    top: `${top}px`,
    left: `${Math.min(Math.max(8, left), window.innerWidth - MENU_WIDTH - 8)}px`,
  }
}

function toggleMenu(chatId: string, event: MouseEvent): void {
  if (openMenuId.value === chatId) {
    closeMenu()
    return
  }
  closeMenu()
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  placeMenu(rect.right - MENU_WIDTH, rect.top, rect.bottom)
  openMenuId.value = chatId
}

function openContextMenu(chatId: string, event: MouseEvent): void {
  closeMenu()
  editingId.value = null
  placeMenu(event.clientX, event.clientY, event.clientY)
  openMenuId.value = chatId
}

function openAgentMenu(entry: AgentEntry, event: MouseEvent | KeyboardEvent): void {
  closeMenu()
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const left = event instanceof MouseEvent ? event.clientX : rect.left
  const top = event instanceof MouseEvent ? event.clientY : rect.bottom
  placeMenu(left, top, top, entry.key === CYNO_KEY ? 44 : 76)
  openAgentMenuKey.value = entry.key
  void nextTick(() => agentMenuRef.value?.querySelector('button')?.focus())
}

async function toggleAgentFavorite(entry: AgentEntry): Promise<void> {
  closeMenu()
  await agentDefs.update(entry.key, { favorite: !entry.favorite })
}

async function editAgent(entry: AgentEntry): Promise<void> {
  closeMenu()
  await router.push(entry.key === CYNO_KEY
    ? { name: 'cyno', query: { returnTo: route.fullPath } }
    : { name: 'agent-detail', params: { id: entry.key }, query: { returnTo: route.fullPath } })
}

function setTitleInput(element: unknown): void {
  titleInputRef.value = element as HTMLInputElement | null
}

async function togglePin(chat: ConversationRow, key: string): Promise<void> {
  closeMenu()
  const pinned = !chat.pinned
  await chatStore.pinConversation(chat.id, pinned)
  chat.pinned = Number(pinned)
  await loadChats(key)
}

function startRename(chat: ConversationRow): void {
  closeMenu()
  editingId.value = chat.id
  editingTitle.value = chat.title
  void nextTick(() => titleInputRef.value?.select())
}

async function commitRename(chat: ConversationRow): Promise<void> {
  if (editingId.value !== chat.id) return
  const title = editingTitle.value.trim()
  editingId.value = null
  if (!title || title === chat.title) return
  await chatStore.renameConversation(chat.id, title)
  chat.title = title
}

async function deleteConversation(chat: ConversationRow, key: string): Promise<void> {
  closeMenu()
  if (chat.pinned) return
  await chatStore.deleteConversation(chat.id)
  const chats = chatsByAgent.value[key]
  if (chats) {
    chats.items = chats.items.filter((item) => item.id !== chat.id)
    chats.total = Math.max(0, chats.total - 1)
  }
  recentChats.value = recentChats.value.filter((item) => item.id !== chat.id)
}

// The open chat's agent unfolds on its own, like the current project does.
watch(activeAgentKey, (key) => {
  if (key !== null && !props.collapsed && !expanded.value.has(key)) setExpanded(key, true)
})

watch(
  [
    () => chatStore.activeConversationId,
    () => chatStore.activeProjectId,
    () => chatStore.conversationListRevision,
    () => props.activeConversationIds.join('|'),
  ],
  refresh,
)

watch(() => props.filters, () => {
  chatsByAgent.value = {}
  refresh()
}, { deep: true })

watch(wsConnected, (connected) => {
  if (connected) refresh()
})

onMounted(() => {
  document.addEventListener('click', closeMenu)
  document.addEventListener('scroll', closeMenu, true)
  window.addEventListener('resize', closeMenu)
  liveCleanups.push(
    api.chat.onEvent((event) => {
      if (event.type === 'title-updated' || (event.type === 'transcript-item' && event.item.type === 'message')) {
        refresh()
      }
    }),
    api.chat.onChannelConversationState(refresh),
    api.chat.onWaitsChanged(refresh),
    api.agent.onHITLRequest(refresh),
  )
  if (!agentDefs.loaded) void agentDefs.load().catch(() => undefined)
  void loadRecent()
})

onBeforeUnmount(() => {
  document.removeEventListener('click', closeMenu)
  document.removeEventListener('scroll', closeMenu, true)
  window.removeEventListener('resize', closeMenu)
  if (refreshTimer) clearTimeout(refreshTimer)
  recentToken++
  liveCleanups.forEach((cleanup) => cleanup())
})
</script>

<template>
  <div
    class="min-h-0 flex-1 space-y-0.5 overflow-y-auto"
    :class="{ 'agents-collapsed': collapsed }"
  >
    <div
      v-for="entry in agents"
      :key="entry.key || 'cyno'"
      class="space-y-0.5"
    >
      <!-- Agent row -->
      <div
        class="group/agent relative"
        @contextmenu.prevent.stop="openAgentMenu(entry, $event)"
      >
        <HoverTooltip
          placement="right"
          block
          :disabled="!collapsed"
        >
          <button
            type="button"
            class="agent-row flex min-h-9 w-full items-center gap-2.5 rounded-lg py-2 pl-3 pr-10 text-left text-[0.8125rem] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500"
            :class="
              activeAgentKey === entry.key
                ? 'agent-row--active text-theme-100'
                : 'text-ink-secondary hover:bg-theme-800 hover:text-theme-100'
            "
            :aria-expanded="collapsed ? undefined : expanded.has(entry.key)"
            :aria-label="entry.name"
            :title="collapsed ? undefined : entry.name"
            @click="selectAgent(entry)"
            @keydown.shift.f10.prevent.stop="openAgentMenu(entry, $event)"
          >
            <span class="relative flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-theme-800">
              <span
                class="h-full w-full"
                :class="{ 'opacity-15': !expanded.has(entry.key) && (runningAgentKeys.has(entry.key) || waitingAgentKeys.has(entry.key)) }"
              >
                <AgentAvatar
                  :name="entry.name"
                  :icon-url="entry.iconUrl"
                  :avatar="entry.avatar"
                  :pending="entry.pending"
                />
              </span>
              <!-- A folded agent shows its chats' status over its face. -->
              <span
                v-if="!expanded.has(entry.key) && runningAgentKeys.has(entry.key) && !awaitingAgentKeys.has(entry.key)"
                class="absolute inset-0 flex items-center justify-center bg-theme-950/30"
                role="img"
                :aria-label="`A chat with ${entry.name} is running`"
              >
                <Icon
                  icon="lucide:loader-circle"
                  class="h-3.5 w-3.5 animate-spin text-accent-fg drop-shadow-sm"
                />
              </span>
              <span
                v-else-if="!expanded.has(entry.key) && waitingAgentKeys.has(entry.key) && !awaitingAgentKeys.has(entry.key)"
                class="absolute inset-0 flex items-center justify-center bg-theme-950/30"
                role="img"
                :aria-label="`A chat with ${entry.name} is waiting to resume`"
                :title="`A chat with ${entry.name} is waiting to resume`"
              >
                <Icon
                  icon="lucide:hourglass"
                  class="h-3.5 w-3.5 text-status-info drop-shadow-sm"
                />
              </span>
              <span
                v-if="!expanded.has(entry.key) && awaitingAgentKeys.has(entry.key)"
                class="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-amber-400 ring-2 ring-theme-900 animate-pulse"
                :title="`A chat with ${entry.name} is waiting for your approval`"
              />
            </span>

            <span
              v-if="!collapsed"
              class="min-w-0 flex-1 truncate"
              :class="{ 'text-amber-200': awaitingAgentKeys.has(entry.key) }"
            >
              {{ entry.name }}
            </span>
          </button>
          <template #content>
            {{ entry.name }}
          </template>
        </HoverTooltip>

        <!-- New chat with this agent -->
        <button
          v-if="!collapsed"
          type="button"
          class="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-ink-muted opacity-0 transition-all hover:bg-theme-700 hover:text-theme-100 hover:opacity-100 group-hover/agent:opacity-100 group-focus-within/agent:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
          :aria-label="`New chat with ${entry.name}`"
          title="New chat"
          @click="startAgentChat(entry)"
        >
          <Icon
            icon="lucide:plus"
            class="h-3.5 w-3.5"
          />
        </button>
      </div>

      <!-- Recent chats; shown once loaded so the list opens to its full height -->
      <Transition
        name="agent-chats"
        @enter="expandHeight"
        @after-enter="clearHeight"
        @leave="collapseHeight"
        @after-leave="clearHeight"
      >
        <ul
          v-if="!collapsed && expanded.has(entry.key) && chatsByAgent[entry.key]"
          class="mb-1 ml-[1.15rem] space-y-0.5 border-l border-theme-800 pl-2"
        >
          <li
            v-for="chat in chatsByAgent[entry.key].items"
            :key="chat.id"
            class="group/chat relative"
          >
            <div
              role="button"
              tabindex="0"
              class="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-theme-800/70"
              :class="[
                chat.id === chatStore.activeConversationId
                  ? 'bg-theme-800 text-theme-100'
                  : 'text-theme-300',
                {
                  'bg-amber-500/20 font-medium text-amber-200 hover:bg-amber-500/25':
                    awaitingIds.has(chat.id),
                },
              ]"
              :title="chat.title"
              @click="openChat(chat)"
              @contextmenu.prevent.stop="openContextMenu(chat.id, $event)"
              @keydown.enter.self.prevent="openChat(chat)"
              @keydown.space.self.prevent="openChat(chat)"
              @keydown.escape="closeMenu"
            >
              <span
                v-if="awaitingIds.has(chat.id)"
                class="h-2 w-2 shrink-0 rounded-full bg-amber-400 animate-pulse"
                aria-label="Waiting for your approval"
              />
              <Icon
                v-else-if="runningIds.has(chat.id)"
                icon="lucide:loader-circle"
                class="h-3 w-3 shrink-0 animate-spin text-accent-fg"
              />
              <Icon
                v-else-if="isWaiting(chat)"
                icon="lucide:hourglass"
                class="h-3 w-3 shrink-0 text-status-info"
                role="img"
                :aria-label="resumeLabel(chat)"
                :title="resumeLabel(chat)"
              />
              <Icon
                v-else-if="chat.origin === 'cron'"
                icon="lucide:calendar-clock"
                class="h-3 w-3 shrink-0 text-ink-faint"
              />

              <Icon
                v-if="chat.pinned"
                icon="lucide:pin"
                class="h-3 w-3 shrink-0 text-status-warning"
              />
              <input
                v-if="editingId === chat.id"
                :ref="setTitleInput"
                v-model="editingTitle"
                class="min-w-0 flex-1 rounded border border-theme-600 bg-theme-900 px-1 py-0.5 text-xs text-theme-100 outline-none"
                aria-label="Conversation title"
                @click.stop
                @blur="commitRename(chat)"
                @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
                @keydown.escape.prevent="editingId = null"
              >
              <span
                v-else
                class="min-w-0 flex-1 truncate"
              >
                {{ chat.title }}
              </span>
              <button
                type="button"
                class="shrink-0 rounded-md p-1 text-ink-muted opacity-0 transition hover:bg-theme-700 hover:text-theme-200 group-hover/chat:opacity-100 focus-visible:opacity-100"
                :class="{ 'bg-theme-700 text-theme-200 opacity-100': openMenuId === chat.id }"
                aria-label="Chat options"
                @click.stop="toggleMenu(chat.id, $event)"
              >
                <Icon
                  icon="lucide:ellipsis"
                  class="h-3.5 w-3.5"
                />
              </button>
            </div>
            <Teleport to="body">
              <div
                v-if="openMenuId === chat.id"
                class="fixed z-200 w-36 overflow-hidden rounded-lg border border-theme-700 bg-theme-900 py-1 shadow-xl"
                :style="menuStyle"
                @click.stop
                @keydown.escape="closeMenu"
              >
                <button
                  type="button"
                  class="flex w-full items-center gap-2 px-3 py-2 text-xs text-theme-300 hover:bg-theme-800"
                  @click="togglePin(chat, entry.key)"
                >
                  <Icon
                    :icon="chat.pinned ? 'lucide:pin-off' : 'lucide:pin'"
                    class="h-3.5 w-3.5 text-status-warning"
                  />
                  {{ chat.pinned ? 'Unpin' : 'Pin' }}
                </button>
                <button
                  type="button"
                  class="flex w-full items-center gap-2 px-3 py-2 text-xs text-theme-300 hover:bg-theme-800"
                  @click="startRename(chat)"
                >
                  <Icon
                    icon="lucide:pencil"
                    class="h-3.5 w-3.5"
                  /> Rename
                </button>
                <button
                  type="button"
                  class="flex w-full items-center gap-2 border-t border-theme-800 px-3 py-2 text-xs text-red-300 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                  :disabled="Boolean(chat.pinned)"
                  :title="chat.pinned ? 'Unpin this chat before deleting it' : undefined"
                  @click="deleteConversation(chat, entry.key)"
                >
                  <Icon
                    icon="lucide:trash-2"
                    class="h-3.5 w-3.5"
                  /> Delete
                </button>
              </div>
            </Teleport>
          </li>

          <!-- Empty state -->
          <li
            v-if="!chatsByAgent[entry.key].items.length"
            class="px-2 py-1 text-[11px] text-ink-faint"
          >
            No chats yet
          </li>

          <!-- Next page -->
          <li v-if="chatsByAgent[entry.key].items.length < chatsByAgent[entry.key].total">
            <button
              type="button"
              class="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] text-ink-muted transition-colors hover:bg-theme-800/70 hover:text-theme-200 disabled:opacity-60"
              :disabled="chatsByAgent[entry.key].loading"
              @click="loadMore(entry.key)"
            >
              <Icon
                v-if="chatsByAgent[entry.key].loading"
                icon="lucide:loader-circle"
                class="h-3 w-3 animate-spin"
              />
              Load more ({{ chatsByAgent[entry.key].total - chatsByAgent[entry.key].items.length }})
            </button>
          </li>
        </ul>
      </Transition>
    </div>

    <!-- Loading skeleton -->
    <template v-if="!recentLoaded && !collapsed">
      <div
        v-for="index in 4"
        :key="`skeleton-${index}`"
        class="flex min-h-9 animate-pulse items-center gap-2.5 px-3 py-2"
      >
        <div class="h-5 w-5 shrink-0 rounded-lg bg-theme-800" />
        <div
          class="h-2.5 rounded bg-theme-800"
          :class="index % 2 === 0 ? 'w-1/2' : 'w-2/3'"
        />
      </div>
    </template>

    <div
      v-else-if="!agents.length && !collapsed"
      class="px-3 py-2 text-[11px] text-ink-faint"
    >
      No matching chats
    </div>
    <Teleport to="body">
      <div
        v-if="menuAgent"
        ref="agentMenuRef"
        role="menu"
        :aria-label="`${menuAgent.name} options`"
        class="fixed z-200 w-36 overflow-hidden rounded-lg border border-theme-700 bg-theme-900 py-1 shadow-xl"
        :style="menuStyle"
        @click.stop
        @contextmenu.prevent
        @keydown.escape.stop.prevent="closeMenu"
      >
        <button
          v-if="menuAgent.key !== CYNO_KEY"
          type="button"
          role="menuitem"
          class="flex w-full items-center gap-2 px-3 py-2 text-xs text-theme-300 hover:bg-theme-800"
          @click="toggleAgentFavorite(menuAgent)"
        >
          <Icon
            :icon="menuAgent.favorite ? 'lucide:star-off' : 'lucide:star'"
            class="h-3.5 w-3.5 text-status-warning"
          />
          {{ menuAgent.favorite ? 'Unfavorite' : 'Favorite' }}
        </button>
        <button
          type="button"
          role="menuitem"
          class="flex w-full items-center gap-2 px-3 py-2 text-xs text-theme-300 hover:bg-theme-800"
          @click="editAgent(menuAgent)"
        >
          <Icon
            icon="lucide:pencil"
            class="h-3.5 w-3.5"
          />
          Edit
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.agents-collapsed {
  scrollbar-width: none;
}

.agents-collapsed::-webkit-scrollbar {
  display: none;
}

.agents-collapsed .agent-row {
  display: flex;
  justify-content: center;
  gap: 0;
  width: 2.5rem;
  min-height: 2.25rem;
  margin-inline: auto;
  padding: 0.5rem;
}

.agent-chats-enter-active,
.agent-chats-leave-active {
  overflow: hidden;
  transition:
    height 200ms cubic-bezier(0.22, 1, 0.36, 1),
    margin-bottom 200ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 160ms ease;
}

.agent-chats-enter-from,
.agent-chats-leave-to {
  margin-bottom: 0;
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .agent-chats-enter-active,
  .agent-chats-leave-active {
    transition: none;
  }
}

.agent-row--active {
  background: var(
    --theme-nav-active-background,
    color-mix(
      in srgb,
      var(--color-accent-500) 10%,
      var(--color-theme-800)
    )
  );

  box-shadow: var(
    --theme-nav-active-shadow,
    inset 3px 0 0 var(--color-accent-500)
  );
}
</style>
