<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api/client'
import type { AgentInstance } from '../api/types'
import { useChatStore } from '../stores/chat.store'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { Icon } from '@iconify/vue'
import TabBar, { type TabDef } from '../components/shared/TabBar.vue'
import BaseCard from '../components/shared/BaseCard.vue'

const router = useRouter()
const chatStore = useChatStore()
const agentDefs = useAgentDefinitionsStore()

// ── Tab state ──
type Tab = 'running' | 'history'
const activeTab = ref<Tab>('running')

const tabs = computed<TabDef<Tab>[]>(() => [
  { value: 'running', label: 'Running', icon: 'lucide:activity', badge: instances.value.length || undefined },
  { value: 'history', label: 'History', icon: 'lucide:clock' }
])

// ── Running instances ──
const instances = ref<AgentInstance[]>([])
const sortedInstances = computed(() => [...instances.value].sort((a, b) => b.startedAt - a.startedAt))
const loading = ref(true)
const now = ref(Date.now())
let pollTimer: ReturnType<typeof setInterval> | undefined
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
    const res = await api.chat.listConversationsPaginated(PAGE_SIZE, offset)
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

// ── Shared formatting ──
function formatStarted(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) {
    return `Today ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDuration(startedAt: number): string {
  const diff = Math.max(0, now.value - startedAt)
  const secs = Math.floor(diff / 1000)
  const mins = Math.floor(secs / 60)
  const hrs = Math.floor(mins / 60)
  const days = Math.floor(hrs / 24)

  if (days > 0) return `${days}d ${hrs % 24}h`
  if (hrs > 0) return `${hrs}h ${mins % 60}m`
  if (mins > 0) return `${mins}m`
  return `${secs}s`
}

function formatTimeAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts)
  const mins = Math.floor(diff / 60_000)
  const hrs = Math.floor(mins / 60)
  const days = Math.floor(hrs / 24)

  if (days > 0) return `${days}d ago`
  if (hrs > 0) return `${hrs}h ago`
  if (mins > 0) return `${mins}m ago`
  return 'Just now'
}

const typeConfig: Record<string, { icon: string; color: string; bg: string; label: string }> = {
  chat: { icon: 'lucide:message-circle', color: 'text-blue-400', bg: 'bg-blue-500/10', label: 'Chat' },
  'multi-agent': { icon: 'lucide:network', color: 'text-purple-400', bg: 'bg-purple-500/10', label: 'Multi-Agent' },
  cron: { icon: 'lucide:clock', color: 'text-sky-400', bg: 'bg-sky-500/10', label: 'Cron' },
  channel: { icon: 'lucide:send', color: 'text-teal-400', bg: 'bg-teal-500/10', label: 'Channel' },
  'file-watcher': { icon: 'lucide:eye', color: 'text-orange-400', bg: 'bg-orange-500/10', label: 'File Watch' }
}

async function openInstance(instance: AgentInstance) {
  await chatStore.setActiveAgent(instance.agentId || null)
  if (instance.conversationId) {
    await chatStore.selectConversation(instance.conversationId)
  }
  router.push('/triggers/chat')
}

async function openConversation(item: HistoryItem) {
  await chatStore.setActiveAgent(item.agent_id)
  await chatStore.selectConversation(item.id)
  router.push('/triggers/chat')
}

const stopping = ref<Set<string>>(new Set())

async function stopInstance(inst: AgentInstance, event: Event) {
  event.stopPropagation()
  if (stopping.value.has(inst.id)) return
  stopping.value.add(inst.id)
  try {
    await api.instances.stop(inst.id)
    await loadInstances()
  } catch {
    // silently ignore — instance may have already finished
  } finally {
    stopping.value.delete(inst.id)
  }
}

onMounted(() => {
  loadInstances()
  loadHistory()
  pollTimer = setInterval(loadInstances, 3_000)
  tickTimer = setInterval(() => { now.value = Date.now() }, 1_000)
  unsubHITLRequest = api.agent.onHITLRequest(() => { loadInstances() })
  unsubExecutionUpdate = api.agent.onExecutionUpdate((data: unknown) => {
    const d = data as { event?: string; data?: { status?: string } }
    if (d.event === 'step:status' && d.data?.status !== 'awaiting-approval') loadInstances()
  })
})

onUnmounted(() => {
  clearInterval(pollTimer)
  clearInterval(tickTimer)
  unsubHITLRequest?.()
  unsubExecutionUpdate?.()
})
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-4xl mx-auto py-8 px-6">
      <div class="mb-6">
        <h1 class="text-2xl font-bold text-zinc-100">
          Instances
        </h1>
        <p class="text-sm text-zinc-500 mt-1">
          Running agent instances and execution history
        </p>
      </div>

      <!-- Tabs -->
      <TabBar
        v-model="activeTab"
        :tabs="tabs"
        class="mb-6"
      />

      <!-- ═══════════════ Running Tab ═══════════════ -->
      <template v-if="activeTab === 'running'">
        <!-- Loading -->
        <BaseCard
          v-if="loading"
          class="p-12 text-center"
        >
          <Icon
            icon="lucide:loader-2"
            class="w-8 h-8 text-zinc-500 animate-spin mx-auto mb-3"
          />
          <p class="text-sm text-zinc-500">
            Loading instances…
          </p>
        </BaseCard>

        <!-- Empty state -->
        <BaseCard
          v-else-if="instances.length === 0"
          class="p-12 text-center"
        >
          <div class="w-16 h-16 rounded-2xl bg-zinc-800 flex items-center justify-center mx-auto mb-4">
            <Icon
              icon="lucide:activity"
              class="w-8 h-8 text-zinc-600"
            />
          </div>
          <h3 class="text-lg font-medium text-zinc-200 mb-2">
            No running instances
          </h3>
          <p class="text-sm text-zinc-500 max-w-md mx-auto">
            Instances appear here when agents have active cron jobs or other triggers.
            Configure a cron schedule on an agent to get started.
          </p>
        </BaseCard>

        <!-- Instance list -->
        <div
          v-else
          class="space-y-2"
        >
          <div
            v-for="inst in sortedInstances"
            :key="inst.id"
            role="button"
            tabindex="0"
            class="w-full flex items-center gap-4 px-5 py-4 rounded-xl border border-zinc-700 bg-zinc-800/60 hover:bg-zinc-800 hover:border-zinc-600 transition-all text-left group cursor-pointer"
            @click="openInstance(inst)"
            @keydown.enter.prevent="openInstance(inst)"
            @keydown.space.prevent="openInstance(inst)"
          >
            <!-- Agent icon -->
            <div class="shrink-0">
              <img
                v-if="inst.agentIconUrl"
                :src="inst.agentIconUrl"
                :alt="inst.agentName"
                class="w-10 h-10 rounded-xl object-cover"
              >
              <div
                v-else
                class="w-10 h-10 rounded-xl bg-zinc-800 flex items-center justify-center"
              >
                <Icon
                  icon="lucide:bot"
                  class="w-5 h-5 text-zinc-500"
                />
              </div>
            </div>

            <!-- Info -->
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <span class="text-sm font-medium text-zinc-200 truncate">{{ inst.agentName }}</span>
                <span
                  :class="[typeConfig[inst.type]?.bg, typeConfig[inst.type]?.color]"
                  class="text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0"
                >
                  {{ typeConfig[inst.type]?.label || inst.type }}
                </span>
              </div>
              <div
                v-if="inst.model"
                class="text-xs text-zinc-500 truncate"
              >
                {{ inst.model }}
              </div>
            </div>

            <!-- Started / Duration -->
            <div class="shrink-0 text-right">
              <div class="text-xs text-zinc-400">
                {{ formatStarted(inst.startedAt) }}
              </div>
              <div class="text-xs text-zinc-600 mt-0.5">
                {{ formatDuration(inst.startedAt) }}
              </div>
            </div>

            <!-- Status -->
            <div class="shrink-0 flex items-center gap-1.5">
              <template v-if="inst.status === 'awaiting-approval'">
                <span class="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                <span class="text-xs text-amber-400">Awaiting Approval</span>
              </template>
              <template v-else>
                <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span class="text-xs text-emerald-400">Running</span>
              </template>
            </div>

            <!-- Stop button -->
            <button
              class="shrink-0 p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors opacity-0 group-hover:opacity-100"
              :class="{ 'opacity-100 text-red-400': stopping.has(inst.id) }"
              title="Stop instance"
              @click="stopInstance(inst, $event)"
            >
              <Icon
                :icon="stopping.has(inst.id) ? 'lucide:loader-2' : 'lucide:square'"
                class="w-4 h-4"
                :class="{ 'animate-spin': stopping.has(inst.id) }"
              />
            </button>

            <!-- Arrow -->
            <Icon
              icon="lucide:chevron-right"
              class="w-4 h-4 text-zinc-600 group-hover:text-zinc-400 transition-colors shrink-0"
            />
          </div>
        </div>
      </template>

      <!-- ═══════════════ History Tab ═══════════════ -->
      <template v-else>
        <!-- Loading -->
        <BaseCard
          v-if="historyLoading && historyItems.length === 0"
          class="p-12 text-center"
        >
          <Icon
            icon="lucide:loader-2"
            class="w-8 h-8 text-zinc-500 animate-spin mx-auto mb-3"
          />
          <p class="text-sm text-zinc-500">
            Loading history…
          </p>
        </BaseCard>

        <!-- Empty state -->
        <BaseCard
          v-else-if="historyItems.length === 0"
          class="p-12 text-center"
        >
          <div class="w-16 h-16 rounded-2xl bg-zinc-800 flex items-center justify-center mx-auto mb-4">
            <Icon
              icon="lucide:message-circle"
              class="w-8 h-8 text-zinc-600"
            />
          </div>
          <h3 class="text-lg font-medium text-zinc-200 mb-2">
            No conversation history
          </h3>
          <p class="text-sm text-zinc-500 max-w-md mx-auto">
            Past conversations will appear here once you start chatting.
          </p>
        </BaseCard>

        <!-- History list -->
        <template v-else>
          <div class="space-y-2">
            <div
              v-for="item in historyItems"
              :key="item.id"
              role="button"
              tabindex="0"
              class="w-full flex items-center gap-4 px-5 py-4 rounded-xl border border-zinc-700 bg-zinc-800/60 hover:bg-zinc-800 hover:border-zinc-600 transition-all text-left group cursor-pointer"
              @click="openConversation(item)"
              @keydown.enter.prevent="openConversation(item)"
              @keydown.space.prevent="openConversation(item)"
            >
              <!-- Agent icon -->
              <div class="shrink-0">
                <img
                  v-if="item.agent_id && agentDefs.get(item.agent_id)?.iconUrl"
                  :src="agentDefs.get(item.agent_id)!.iconUrl!"
                  :alt="agentDefs.get(item.agent_id)?.name"
                  class="w-10 h-10 rounded-xl object-cover"
                >
                <div
                  v-else
                  class="w-10 h-10 rounded-xl bg-zinc-800 flex items-center justify-center"
                >
                  <Icon
                    icon="lucide:message-circle"
                    class="w-5 h-5 text-zinc-500"
                  />
                </div>
              </div>

              <!-- Info -->
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-sm font-medium text-zinc-200 truncate">{{ item.title || 'Untitled' }}</span>
                  <span
                    v-if="item.agent_id && agentDefs.get(item.agent_id)"
                    class="text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0 bg-blue-500/10 text-blue-400"
                  >
                    {{ agentDefs.get(item.agent_id)!.name }}
                  </span>
                  <span
                    v-else-if="!item.agent_id"
                    class="text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0 bg-zinc-700/50 text-zinc-400"
                  >
                    Free Chat
                  </span>
                </div>
                <div
                  v-if="item.last_user_message"
                  class="text-xs text-zinc-500 truncate"
                >
                  {{ item.last_user_message }}
                </div>
              </div>

              <!-- Time -->
              <div class="shrink-0 text-right">
                <div class="text-xs text-zinc-400">
                  {{ formatStarted(item.updated_at) }}
                </div>
                <div class="text-xs text-zinc-600 mt-0.5">
                  {{ formatTimeAgo(item.updated_at) }}
                </div>
              </div>

              <!-- Arrow -->
              <Icon
                icon="lucide:chevron-right"
                class="w-4 h-4 text-zinc-600 group-hover:text-zinc-400 transition-colors shrink-0"
              />
            </div>
          </div>

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
            <span class="text-sm text-zinc-500">
              Page {{ historyPage }} of {{ historyPages }}
            </span>
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
      </template>
    </div>
  </div>
</template>
