<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import { api } from '../../api/client'
import type { CronJob, McpServerInfo } from '../../api/types'
import { useAgentDefinitionsStore, type AgentDefinition } from '../../stores/agent-definitions.store'
import { useChatStore } from '../../stores/chat.store'
import { useCommandPalette } from '../../composables/useCommandPalette'
import { useMcpServers } from '../../composables/useMcpServers'
import { rankItems } from '../../utils/command-palette'
import { cronToHuman } from '../../utils/cron-helpers'

type Scope = 'all' | 'conversations' | 'agents' | 'mcp' | 'cron'
type GroupId = Exclude<Scope, 'all'>

interface ConversationHit {
  id: string
  title: string
  agentId: string | null
  origin: string
  updatedAt: number
}

interface PaletteItem {
  key: string
  title: string
  subtitle: string
  icon: string
  imageUrl?: string | null
  badge?: { label: string; tone: 'ok' | 'warn' | 'muted' }
  meta?: string
  run: () => Promise<unknown> | void
}

interface PaletteGroup {
  id: GroupId
  label: string
  items: PaletteItem[]
}

const SCOPES: Array<{ id: Scope; label: string; icon: string }> = [
  { id: 'all', label: 'All', icon: 'lucide:search' },
  { id: 'conversations', label: 'Chats', icon: 'lucide:messages-square' },
  { id: 'agents', label: 'Agents', icon: 'lucide:bot' },
  { id: 'mcp', label: 'MCP Servers', icon: 'lucide:plug' },
  { id: 'cron', label: 'Schedules', icon: 'lucide:calendar-clock' },
]

const GROUP_LIMIT = 5
const SCOPED_LIMIT = 50
const SEARCH_DEBOUNCE_MS = 150

const router = useRouter()
const chatStore = useChatStore()
const agentDefs = useAgentDefinitionsStore()
const { servers: mcpServers, loadServers: loadMcpServers } = useMcpServers()
const { commandPaletteOpen, close } = useCommandPalette()

const query = ref('')
const scope = ref<Scope>('all')
const activeIndex = ref(0)
const inputRef = ref<HTMLInputElement | null>(null)
const listRef = ref<HTMLElement | null>(null)
const conversations = ref<ConversationHit[]>([])
const conversationsLoading = ref(false)
const cronJobs = ref<CronJob[]>([])
let conversationRequest = 0
let searchTimer: ReturnType<typeof setTimeout> | null = null
let previouslyFocused: HTMLElement | null = null

const groupLimit = computed(() => scope.value === 'all' ? GROUP_LIMIT : SCOPED_LIMIT)
const trimmedQuery = computed(() => query.value.trim())

function formatTimeAgo(ts: number): string {
  const mins = Math.floor(Math.max(0, Date.now() - ts) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function conversationIcon(origin: string): string {
  if (origin === 'cron') return 'lucide:calendar-clock'
  if (['channel', 'discord', 'slack', 'webhook'].includes(origin)) return 'lucide:radio'
  return 'lucide:message-square'
}

function agentName(agentId: string | null): string {
  return agentId ? agentDefs.get(agentId)?.name ?? 'Agent' : 'Free chat'
}

async function openConversation(conversation: ConversationHit): Promise<void> {
  await chatStore.selectConversation(conversation.id, conversation.agentId)
  await router.push({ name: 'conversation', params: { conversationId: conversation.id } })
}

function conversationItem(conversation: ConversationHit): PaletteItem {
  return {
    key: `conversation:${conversation.id}`,
    title: conversation.title || 'Untitled chat',
    subtitle: agentName(conversation.agentId),
    icon: conversationIcon(conversation.origin),
    meta: formatTimeAgo(conversation.updatedAt),
    run: () => openConversation(conversation),
  }
}

function agentItem(agent: AgentDefinition): PaletteItem {
  return {
    key: `agent:${agent.id}`,
    title: agent.name,
    subtitle: agent.description || agent.category || 'Agent',
    icon: 'lucide:bot',
    imageUrl: agent.iconUrl,
    run: () => router.push({ name: 'agent-detail', params: { id: agent.id } }),
  }
}

function mcpItem(server: McpServerInfo): PaletteItem {
  const badge: PaletteItem['badge'] = server.connected
    ? { label: 'Connected', tone: 'ok' }
    : server.enabled
      ? { label: server.pendingAuthUrl ? 'Needs auth' : 'Offline', tone: 'warn' }
      : { label: 'Disabled', tone: 'muted' }
  return {
    key: `mcp:${server.id}`,
    title: server.name,
    subtitle: server.description || server.serverInfo?.description || `${server.toolCount} tools`,
    icon: 'lucide:plug',
    imageUrl: server.icon_url,
    badge,
    run: () => router.push({ name: 'settings-mcp', query: { filter: server.name } }),
  }
}

function cronItem(job: CronJob): PaletteItem {
  const badge: PaletteItem['badge'] = job.isRunning
    ? { label: 'Running', tone: 'ok' }
    : job.enabled
      ? undefined
      : { label: 'Paused', tone: 'muted' }
  return {
    key: `cron:${job.id}`,
    title: job.name,
    subtitle: `${cronToHuman(job.schedule)} · ${job.agentName}`,
    icon: 'lucide:calendar-clock',
    badge,
    run: () => router.push({ name: 'cron-detail', params: { id: job.id } }),
  }
}

const groups = computed<PaletteGroup[]>(() => {
  const q = trimmedQuery.value
  const limit = groupLimit.value
  const all: PaletteGroup[] = [
    {
      id: 'conversations',
      label: q ? 'Chats' : 'Recent chats',
      items: conversations.value.slice(0, limit).map(conversationItem),
    },
    {
      id: 'agents',
      label: 'Agents',
      items: rankItems(agentDefs.agents, q, (a) => [a.name, a.category, a.description], limit).map(agentItem),
    },
    {
      id: 'mcp',
      label: 'MCP Servers',
      items: rankItems(mcpServers.value, q, (s) => [s.name, s.originalName, s.serverInfo?.title, s.description], limit).map(mcpItem),
    },
    {
      id: 'cron',
      label: 'Scheduled Jobs',
      items: rankItems(cronJobs.value, q, (j) => [j.name, j.agentName, j.prompt], limit).map(cronItem),
    },
  ]
  return all.filter((group) => (scope.value === 'all' || group.id === scope.value) && group.items.length > 0)
})

const flatItems = computed(() => groups.value.flatMap((group) => group.items))
const activeItem = computed(() => flatItems.value[activeIndex.value])

function itemIndex(item: PaletteItem): number {
  return flatItems.value.indexOf(item)
}

function optionId(item: PaletteItem): string {
  return `command-palette-${item.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

async function searchConversations(): Promise<void> {
  const request = ++conversationRequest
  conversationsLoading.value = true
  try {
    const limit = scope.value === 'conversations' ? SCOPED_LIMIT : GROUP_LIMIT
    const response = await api.chat.listConversationsPaginated(limit, 0, 'updated', trimmedQuery.value || undefined)
    if (request !== conversationRequest) return
    conversations.value = response.items.map((row) => ({
      id: row.id,
      title: row.title,
      agentId: row.agent_id,
      origin: row.origin,
      updatedAt: row.updated_at,
    }))
  } catch {
    if (request === conversationRequest) conversations.value = []
  } finally {
    if (request === conversationRequest) conversationsLoading.value = false
  }
}

function scheduleConversationSearch(): void {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    searchTimer = null
    void searchConversations()
  }, SEARCH_DEBOUNCE_MS)
}

async function loadSources(): Promise<void> {
  await Promise.all([
    searchConversations(),
    agentDefs.loaded ? Promise.resolve() : agentDefs.load().catch(() => undefined),
    loadMcpServers().catch(() => undefined),
    api.cronJobs.list().then((jobs) => { cronJobs.value = jobs }).catch(() => undefined),
  ])
}

watch(query, () => {
  if (!commandPaletteOpen.value) return
  activeIndex.value = 0
  scheduleConversationSearch()
})

watch(scope, () => {
  if (!commandPaletteOpen.value) return
  activeIndex.value = 0
  void searchConversations()
})

watch(flatItems, (items) => {
  if (activeIndex.value >= items.length) activeIndex.value = Math.max(0, items.length - 1)
})

watch(commandPaletteOpen, async (open) => {
  if (open) {
    previouslyFocused = document.activeElement as HTMLElement | null
    void loadSources()
    await nextTick()
    inputRef.value?.focus()
  } else {
    if (searchTimer) clearTimeout(searchTimer)
    conversationRequest++
    conversationsLoading.value = false
    // Reset while closed so the next open starts fresh without extra requests.
    query.value = ''
    scope.value = 'all'
    activeIndex.value = 0
    previouslyFocused?.focus?.()
    previouslyFocused = null
  }
}, { immediate: true })

function scrollActiveIntoView(): void {
  void nextTick(() => {
    const item = activeItem.value
    if (!item) return
    listRef.value?.querySelector(`#${optionId(item)}`)?.scrollIntoView({ block: 'nearest' })
  })
}

function moveActive(delta: number): void {
  const count = flatItems.value.length
  if (!count) return
  activeIndex.value = (activeIndex.value + delta + count) % count
  scrollActiveIntoView()
}

function cycleScope(delta: number): void {
  const index = SCOPES.findIndex((entry) => entry.id === scope.value)
  scope.value = SCOPES[(index + delta + SCOPES.length) % SCOPES.length].id
}

async function runItem(item: PaletteItem | undefined): Promise<void> {
  if (!item) return
  close()
  await item.run()
}

function onKeydown(event: KeyboardEvent): void {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      moveActive(1)
      break
    case 'ArrowUp':
      event.preventDefault()
      moveActive(-1)
      break
    case 'Enter':
      event.preventDefault()
      void runItem(activeItem.value)
      break
    case 'Tab':
      event.preventDefault()
      cycleScope(event.shiftKey ? -1 : 1)
      break
    case 'Escape':
      // Keep the Escape from also closing a dialog underneath the palette.
      event.preventDefault()
      event.stopPropagation()
      close()
      break
  }
}

const badgeClass: Record<NonNullable<PaletteItem['badge']>['tone'], string> = {
  ok: 'bg-emerald-500/10 text-emerald-400',
  warn: 'bg-amber-500/10 text-amber-400',
  muted: 'bg-theme-800 text-ink-muted',
}
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-150"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-100"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="commandPaletteOpen"
        class="fixed inset-0 z-1100 flex items-start justify-center bg-black/60 p-4 pt-[12vh] backdrop-blur-sm"
        @mousedown.self="close"
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Search"
          class="command-palette flex max-h-[70vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-theme-800 bg-theme-900 shadow-2xl"
        >
          <!-- Search input -->
          <div class="flex items-center gap-3 border-b border-theme-800 px-4">
            <Icon
              icon="lucide:search"
              class="h-4.5 w-4.5 shrink-0 text-ink-muted"
            />
            <input
              ref="inputRef"
              v-model="query"
              type="text"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls="command-palette-list"
              :aria-activedescendant="activeItem ? optionId(activeItem) : undefined"
              placeholder="Search chats, agents, MCP servers, schedules..."
              class="min-w-0 flex-1 bg-transparent py-4 text-sm text-theme-100 outline-none placeholder:text-ink-faint"
              spellcheck="false"
              autocomplete="off"
              @keydown="onKeydown"
            >
            <Icon
              v-if="conversationsLoading"
              icon="lucide:loader-circle"
              class="h-4 w-4 shrink-0 animate-spin text-ink-faint"
            />
            <kbd class="hidden shrink-0 rounded border border-theme-700 bg-theme-800 px-1.5 py-0.5 font-mono text-[10px] text-ink-faint sm:inline-flex">
              Esc
            </kbd>
          </div>

          <!-- Scope chips -->
          <div class="flex gap-1 overflow-x-auto border-b border-theme-800/60 px-3 py-2">
            <button
              v-for="entry in SCOPES"
              :key="entry.id"
              type="button"
              tabindex="-1"
              class="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors"
              :class="scope === entry.id
                ? 'bg-accent-500/15 text-accent-fg'
                : 'text-ink-muted hover:bg-theme-800 hover:text-theme-200'"
              :aria-pressed="scope === entry.id"
              @mousedown.prevent
              @click="scope = entry.id"
            >
              <Icon
                :icon="entry.icon"
                class="h-3.5 w-3.5"
              />
              {{ entry.label }}
            </button>
          </div>

          <!-- Results -->
          <div
            id="command-palette-list"
            ref="listRef"
            role="listbox"
            aria-label="Search results"
            class="min-h-0 flex-1 overflow-y-auto p-2"
          >
            <div
              v-for="group in groups"
              :key="group.id"
              role="group"
              :aria-label="group.label"
              class="mb-1 last:mb-0"
            >
              <div class="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                {{ group.label }}
              </div>
              <div
                v-for="item in group.items"
                :id="optionId(item)"
                :key="item.key"
                role="option"
                :aria-selected="activeItem === item"
                class="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 transition-colors"
                :class="activeItem === item ? 'bg-theme-800 text-theme-100' : 'text-theme-300'"
                @mousemove="activeIndex = itemIndex(item)"
                @mousedown.prevent
                @click="runItem(item)"
              >
                <div class="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-theme-800/80">
                  <img
                    v-if="item.imageUrl"
                    :src="item.imageUrl"
                    alt=""
                    class="h-full w-full object-cover"
                  >
                  <Icon
                    v-else
                    :icon="item.icon"
                    class="h-4 w-4 text-ink-muted"
                  />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="truncate text-sm font-medium">
                    {{ item.title }}
                  </div>
                  <div class="truncate text-xs text-ink-muted">
                    {{ item.subtitle }}
                  </div>
                </div>
                <span
                  v-if="item.badge"
                  class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
                  :class="badgeClass[item.badge.tone]"
                >
                  {{ item.badge.label }}
                </span>
                <span
                  v-if="item.meta"
                  class="shrink-0 text-[11px] text-ink-faint"
                >
                  {{ item.meta }}
                </span>
                <Icon
                  v-if="activeItem === item"
                  icon="lucide:corner-down-left"
                  class="h-3.5 w-3.5 shrink-0 text-ink-faint"
                />
              </div>
            </div>

            <div
              v-if="!flatItems.length && !conversationsLoading"
              class="flex flex-col items-center gap-2 px-4 py-10 text-center"
            >
              <Icon
                icon="lucide:search-x"
                class="h-6 w-6 text-ink-faint"
              />
              <p class="text-sm text-theme-300">
                {{ trimmedQuery ? `No results for “${trimmedQuery}”` : 'Nothing here yet' }}
              </p>
            </div>
          </div>

          <!-- Footer hints -->
          <div class="hidden items-center gap-4 border-t border-theme-800 px-4 py-2 text-[11px] text-ink-faint sm:flex">
            <span class="flex items-center gap-1"><kbd class="palette-kbd">↑</kbd><kbd class="palette-kbd">↓</kbd> navigate</span>
            <span class="flex items-center gap-1"><kbd class="palette-kbd">↵</kbd> open</span>
            <span class="flex items-center gap-1"><kbd class="palette-kbd">Tab</kbd> filter</span>
            <span class="flex items-center gap-1"><kbd class="palette-kbd">Esc</kbd> close</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.palette-kbd {
  display: inline-flex;
  min-width: 1.25rem;
  justify-content: center;
  border-radius: 0.25rem;
  border: 1px solid var(--color-theme-700);
  background-color: var(--color-theme-800);
  padding: 0 0.25rem;
  font-family: ui-monospace, monospace;
  font-size: 10px;
}
</style>
