<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { api, type AgentInstance } from '../api/client'
import { useChatStore } from '../stores/chat.store'
import { Icon } from '@iconify/vue'

const router = useRouter()
const chatStore = useChatStore()
const instances = ref<AgentInstance[]>([])
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

const typeConfig: Record<string, { icon: string; color: string; bg: string; label: string }> = {
  chat: { icon: 'lucide:message-circle', color: 'text-blue-400', bg: 'bg-blue-500/10', label: 'Chat' },
  'multi-agent': { icon: 'lucide:network', color: 'text-purple-400', bg: 'bg-purple-500/10', label: 'Multi-Agent' },
  cron: { icon: 'lucide:clock', color: 'text-sky-400', bg: 'bg-sky-500/10', label: 'Cron' },
  channel: { icon: 'lucide:send', color: 'text-teal-400', bg: 'bg-teal-500/10', label: 'Channel' },
  'file-watcher': { icon: 'lucide:eye', color: 'text-orange-400', bg: 'bg-orange-500/10', label: 'File Watch' }
}

function openInstance(instance: AgentInstance) {
  if (!instance.agentId) {
    // Default/agentless chat — open the conversation directly
    if (instance.conversationId) {
      chatStore.activeAgentId = null
      chatStore.activeConversationId = instance.conversationId
      router.push('/triggers/chat')
    }
    return
  }
  router.push({
    name: 'instance-detail',
    params: { agentId: instance.agentId },
    query: {
      ...(instance.conversationId ? { conversation: instance.conversationId } : {}),
      type: instance.type
    }
  })
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
          Running agent instances — cron jobs, active executions, and scheduled tasks
        </p>
      </div>

      <!-- Loading -->
      <div
        v-if="loading"
        class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-12 text-center"
      >
        <Icon
          icon="lucide:loader-2"
          class="w-8 h-8 text-zinc-500 animate-spin mx-auto mb-3"
        />
        <p class="text-sm text-zinc-500">
          Loading instances…
        </p>
      </div>

      <!-- Empty state -->
      <div
        v-else-if="instances.length === 0"
        class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-12 text-center"
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
      </div>

      <!-- Instance list -->
      <div
        v-else
        class="space-y-2"
      >
        <div
          v-for="inst in instances"
          :key="inst.id"
          role="button"
          tabindex="0"
          class="w-full flex items-center gap-4 px-5 py-4 rounded-xl border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-800/80 hover:border-zinc-700 transition-all text-left group cursor-pointer"
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
    </div>
  </div>
</template>
