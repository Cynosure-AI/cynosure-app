<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api/client'
import type { AgentInstance } from '../api/types'
import { useChatStore } from '../stores/chat.store'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { Icon } from '@iconify/vue'
import BaseCard from '../components/shared/BaseCard.vue'
import DataTable, { type Column } from '../components/shared/DataTable.vue'

const router = useRouter()
const chatStore = useChatStore()
const agentDefs = useAgentDefinitionsStore()

// ── Running instances ──
const instances = ref<AgentInstance[]>([])
const loading = ref(true)
const now = ref(Date.now())

let pollTimer: ReturnType<typeof setInterval> | undefined
let historyPollTimer: ReturnType<typeof setInterval> | undefined
let tickTimer: ReturnType<typeof setInterval> | undefined
let unsubHITLRequest: (() => void) | undefined
let unsubExecutionUpdate: (() => void) | undefined

async function loadInstances() {
  try {
    instances.value = await api.instances.list()
  } catch {
    // silently ignore
  } finally {
    loading.value = false
  }
}

// ── History (paginated conversations) ──
const PAGE_SIZE = 20

interface HistoryItem {
  id: string
  title: string
  agent_id: string | null
  origin: string
  updated_at: number
  last_user_message: string | null
}

const historyItems = ref<HistoryItem[]>([])
const historyTotal = ref(0)
const historyPage = ref(1)
const historyLoading = ref(false)
const historyPages = computed(() => Math.max(1, Math.ceil(historyTotal.value / PAGE_SIZE)))

async function loadHistory() {
  historyLoading.value = true
  try {
    const offset = (historyPage.value - 1) * PAGE_SIZE
    const res = await api.chat.listConversationsPaginated(PAGE_SIZE, offset, 'updated')
    historyItems.value = res.items
    historyTotal.value = res.total
  } catch {
    // silently ignore
  } finally {
    historyLoading.value = false
  }
}

function goToPage(page: number) {
  historyPage.value = page
  loadHistory()
}

// ── Formatting ──
function formatStarted(ts: number): string {
  const d = new Date(ts)
  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === new Date().toDateString()) return `Today ${timeStr}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${timeStr}`
}

function formatDuration(startedAt: number): string {
  const secs = Math.floor(Math.max(0, now.value - startedAt) / 1000)
  const mins = Math.floor(secs / 60)
  const hrs = Math.floor(mins / 60)
  const days = Math.floor(hrs / 24)
  if (days > 0) return `${days}d ${hrs % 24}h`
  if (hrs > 0) return `${hrs}h ${mins % 60}m`
  if (mins > 0) return `${mins}m`
  return `${secs}s`
}

function formatTimeAgo(ts: number): string {
  const mins = Math.floor(Math.max(0, Date.now() - ts) / 60_000)
  const hrs = Math.floor(mins / 60)
  const days = Math.floor(hrs / 24)
  if (days > 0) return `${days}d ago`
  if (hrs > 0) return `${hrs}h ago`
  if (mins > 0) return `${mins}m ago`
  return 'Just now'
}

// ── Origin badge config (only origins that get a badge) ──
const originBadgeConfig: Record<string, { icon: string; color: string; bg: string; label: string }> = {
  chat:         { icon: 'lucide:message-circle', color: 'text-blue-400',   bg: 'bg-blue-500/10',   label: 'Chat' },
  'multi-agent':{ icon: 'lucide:network',        color: 'text-purple-400', bg: 'bg-purple-500/10', label: 'Multi-Agent' },
  cron:         { icon: 'lucide:clock',          color: 'text-sky-400',    bg: 'bg-sky-500/10',    label: 'Cron' },
  channel:      { icon: 'lucide:send',           color: 'text-teal-400',   bg: 'bg-teal-500/10',   label: 'Channel' },
  'file-watcher':{ icon: 'lucide:eye',           color: 'text-orange-400', bg: 'bg-orange-500/10', label: 'File Watch' },
}

// Only channel/cron/file-watcher get badges on history rows
const HISTORY_BADGE_ORIGINS = new Set(['channel', 'cron', 'file-watcher'])

// ── Timeline ──
type TimelineItem =
  | { id: string; kind: 'running'; ts: number; running: AgentInstance }
  | { id: string; kind: 'history'; ts: number; history: HistoryItem }

const timelineColumns: Column[] = [
  { key: 'entry',   label: 'Entry',   width: 'minmax(0, 2.2fr)' },
  { key: 'details', label: 'Details', width: 'minmax(0, 1.7fr)', hideOnMobile: true },
  { key: 'time',    label: 'Time',    width: '180px',            hideOnMobile: true },
  { key: 'status',  label: 'Status',  width: '170px' },
]

// Cache agent lookups so the template doesn't call agentDefs.get() repeatedly per row
const agentById = computed(() => {
  const ids = new Set([
    ...instances.value.map(i => i.agentId),
    ...historyItems.value.map(i => i.agent_id).filter(Boolean),
  ])
  return Object.fromEntries([...ids].map(id => [id, agentDefs.get(id!)]))
})

const runningConversationIds = computed(() =>
  new Set(instances.value.map(i => i.conversationId).filter((id): id is string => Boolean(id)))
)

const timelineItems = computed<TimelineItem[]>(() => {
  const running: TimelineItem[] = [...instances.value]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(inst => ({ id: `running:${inst.id}`, kind: 'running', ts: inst.startedAt, running: inst }))

  const history: TimelineItem[] = [...historyItems.value]
    .filter(item => !runningConversationIds.value.has(item.id))
    .sort((a, b) => b.updated_at - a.updated_at)
    .map(item => ({ id: `history:${item.id}`, kind: 'history', ts: item.updated_at, history: item }))

  return [...running, ...history]
})

const showLoading = computed(() =>
  (loading.value || historyLoading.value) && timelineItems.value.length === 0
)

// ── Navigation ──
async function openInstance(instance: AgentInstance) {
  await chatStore.setActiveAgent(instance.agentId || null)
  if (instance.conversationId) await chatStore.selectConversation(instance.conversationId)
  router.push('/triggers/chat')
}

async function openConversation(item: HistoryItem) {
  await chatStore.setActiveAgent(item.agent_id)
  await chatStore.selectConversation(item.id)
  router.push('/triggers/chat')
}

function openTimelineItem(item: TimelineItem) {
  if (item.kind === 'running') void openInstance(item.running)
  else void openConversation(item.history)
}

// ── Stop ──
const stopping = ref<Set<string>>(new Set())

async function stopInstance(inst: AgentInstance, event: Event) {
  event.stopPropagation()
  if (stopping.value.has(inst.id)) return
  stopping.value.add(inst.id)
  try {
    await api.instances.stop(inst.id)
    await Promise.all([loadInstances(), loadHistory()])
  } catch {
    // silently ignore — instance may have already finished
  } finally {
    stopping.value.delete(inst.id)
  }
}

onMounted(() => {
  loadInstances()
  loadHistory()
  pollTimer        = setInterval(loadInstances, 3_000)
  historyPollTimer = setInterval(loadHistory,   15_000)
  tickTimer        = setInterval(() => { now.value = Date.now() }, 1_000)
  unsubHITLRequest    = api.agent.onHITLRequest(() => loadInstances())
  unsubExecutionUpdate = api.agent.onExecutionUpdate((data: unknown) => {
    const d = data as { event?: string; data?: { status?: string } }
    if (d.event === 'step:status' && d.data?.status !== 'awaiting-approval') {
      void Promise.all([loadInstances(), loadHistory()])
    }
  })
})

onUnmounted(() => {
  clearInterval(pollTimer)
  clearInterval(historyPollTimer)
  clearInterval(tickTimer)
  unsubHITLRequest?.()
  unsubExecutionUpdate?.()
})
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-6xl mx-auto py-8 px-6">
      <div class="mb-6">
        <h1 class="text-2xl font-bold text-zinc-100">
          Instances Timeline
        </h1>
        <p class="text-sm text-zinc-500 mt-1">
          Running instances are pinned on top, with historical entries below in chronological order.
        </p>
      </div>

      <!-- Loading -->
      <BaseCard
        v-if="showLoading"
        class="p-12 text-center"
      >
        <Icon
          icon="lucide:loader-2"
          class="w-8 h-8 text-zinc-500 animate-spin mx-auto mb-3"
        />
        <p class="text-sm text-zinc-500">
          Loading timeline…
        </p>
      </BaseCard>

      <!-- Empty state -->
      <BaseCard
        v-else-if="timelineItems.length === 0"
        class="p-12 text-center"
      >
        <div class="w-16 h-16 rounded-2xl bg-zinc-800 flex items-center justify-center mx-auto mb-4">
          <Icon
            icon="lucide:activity"
            class="w-8 h-8 text-zinc-600"
          />
        </div>
        <h3 class="text-lg font-medium text-zinc-200 mb-2">
          No timeline entries yet
        </h3>
        <p class="text-sm text-zinc-500 max-w-md mx-auto">
          Running instances and recent conversations will appear here.
        </p>
      </BaseCard>

      <template v-else>
        <DataTable
          :items="timelineItems"
          :columns="timelineColumns"
          empty-message="No timeline entries"
          @row-click="openTimelineItem"
        >
          <!-- Entry -->
          <template #col-entry="{ item }">
            <div class="flex items-center gap-3 min-w-0">
              <img
                v-if="item.kind === 'running' && item.running.agentIconUrl"
                :src="item.running.agentIconUrl"
                :alt="item.running.agentName"
                class="w-10 h-10 rounded-xl object-cover shrink-0"
              >
              <img
                v-else-if="item.kind === 'history' && agentById[item.history.agent_id!]?.iconUrl"
                :src="agentById[item.history.agent_id!]!.iconUrl!"
                :alt="agentById[item.history.agent_id!]?.name"
                class="w-10 h-10 rounded-xl object-cover shrink-0"
              >
              <div
                v-else
                class="w-10 h-10 rounded-xl bg-zinc-800 flex items-center justify-center shrink-0"
              >
                <Icon
                  :icon="item.kind === 'running' ? 'lucide:bot' : 'lucide:message-circle'"
                  class="w-5 h-5 text-zinc-500"
                />
              </div>
              <div class="min-w-0">
                <div class="text-sm font-medium text-zinc-200 truncate">
                  {{ item.kind === 'running' ? item.running.agentName : (item.history.title || 'Untitled') }}
                </div>
                <div
                  v-if="item.kind === 'history' && item.history.last_user_message"
                  class="text-xs text-zinc-500 truncate mt-0.5"
                >
                  {{ item.history.last_user_message }}
                </div>
              </div>
            </div>
          </template>

          <!-- Details -->
          <template #col-details="{ item }">
            <div class="flex flex-wrap items-center gap-1.5">
              <!-- Type / origin badge -->
              <template v-if="item.kind === 'running'">
                <span
                  v-if="originBadgeConfig[item.running.type]"
                  :class="[originBadgeConfig[item.running.type].bg, originBadgeConfig[item.running.type].color]"
                  class="text-[10px] font-medium px-2 py-0.5 rounded-full"
                >
                  {{ originBadgeConfig[item.running.type].label }}
                </span>
                <span
                  v-if="agentById[item.running.agentId]?.model || item.running.model"
                  class="text-xs text-zinc-500 truncate max-w-50"
                >
                  {{ item.running.model || agentById[item.running.agentId]?.model }}
                </span>
              </template>
              <template v-else>
                <span
                  v-if="HISTORY_BADGE_ORIGINS.has(item.history.origin) && originBadgeConfig[item.history.origin]"
                  :class="[originBadgeConfig[item.history.origin].bg, originBadgeConfig[item.history.origin].color]"
                  class="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full"
                >
                  <Icon
                    :icon="originBadgeConfig[item.history.origin].icon"
                    class="w-3 h-3"
                  />
                  {{ originBadgeConfig[item.history.origin].label }}
                </span>
                <span
                  v-if="item.history.agent_id && agentById[item.history.agent_id]"
                  class="text-[10px] font-medium px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400"
                >
                  {{ agentById[item.history.agent_id]!.name }}
                </span>
                <span
                  v-else-if="!item.history.agent_id"
                  class="text-[10px] font-medium px-2 py-0.5 rounded-full bg-zinc-700/50 text-zinc-400"
                >
                  Free Chat
                </span>
                <span
                  v-if="agentById[item.history.agent_id!]?.model"
                  class="text-xs text-zinc-500 truncate max-w-50"
                >
                  {{ agentById[item.history.agent_id!]!.model }}
                </span>
              </template>
            </div>
          </template>

          <!-- Time — use item.ts directly, avoids per-kind ternaries -->
          <template #col-time="{ item }">
            <div class="text-xs text-zinc-400">
              {{ formatStarted(item.ts) }}
            </div>
            <div class="text-xs text-zinc-600 mt-0.5">
              {{ item.kind === 'running' ? formatDuration(item.ts) : formatTimeAgo(item.ts) }}
            </div>
          </template>

          <!-- Status -->
          <template #col-status="{ item }">
            <div class="flex items-center justify-between gap-3">
              <div class="flex items-center gap-1.5">
                <template v-if="item.kind === 'running' && item.running.status === 'awaiting-approval'">
                  <span class="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                  <span class="text-xs text-amber-400">Awaiting Approval</span>
                </template>
                <template v-else-if="item.kind === 'running'">
                  <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  <span class="text-xs text-emerald-400">Running</span>
                </template>
                <template v-else>
                  <span class="w-2 h-2 rounded-full bg-zinc-500" />
                  <span class="text-xs text-zinc-400">Completed</span>
                </template>
              </div>
              <button
                v-if="item.kind === 'running'"
                class="shrink-0 p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                :class="{ 'text-red-400': stopping.has(item.running.id) }"
                title="Stop instance"
                @click="stopInstance(item.running, $event)"
              >
                <Icon
                  :icon="stopping.has(item.running.id) ? 'lucide:loader-2' : 'lucide:square'"
                  class="w-4 h-4"
                  :class="{ 'animate-spin': stopping.has(item.running.id) }"
                />
              </button>
              <Icon
                v-else
                icon="lucide:chevron-right"
                class="w-4 h-4 text-zinc-600"
              />
            </div>
          </template>
        </DataTable>

        <!-- Pagination -->
        <div
          v-if="historyPages > 1"
          class="flex items-center justify-center gap-2 mt-6"
        >
          <button
            class="px-3 py-1.5 text-sm rounded-lg border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors disabled:opacity-40 disabled:pointer-events-none"
            :disabled="historyPage <= 1"
            @click="goToPage(historyPage - 1)"
          >
            <Icon
              icon="lucide:chevron-left"
              class="w-4 h-4"
            />
          </button>
          <span class="text-sm text-zinc-500">Page {{ historyPage }} of {{ historyPages }}</span>
          <button
            class="px-3 py-1.5 text-sm rounded-lg border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors disabled:opacity-40 disabled:pointer-events-none"
            :disabled="historyPage >= historyPages"
            @click="goToPage(historyPage + 1)"
          >
            <Icon
              icon="lucide:chevron-right"
              class="w-4 h-4"
            />
          </button>
        </div>
      </template>
    </div>
  </div>
</template>
