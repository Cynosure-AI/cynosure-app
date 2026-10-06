<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { api } from '../../api/client'
import type { MetricsSummary } from '../../api/types'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import { Icon } from '@iconify/vue'
import ModalDialog from './ModalDialog.vue'
import DailyActivityChart from './DailyActivityChart.vue'
import HoverTooltip from './HoverTooltip.vue'
import BaseCard from './BaseCard.vue'

const agentDefs = useAgentDefinitionsStore()

const loading = ref(true)
const error = ref<string | null>(null)
const metrics = ref<MetricsSummary | null>(null)
const selectedDays = ref(30)
const dayOptions = [1, 7, 30, 90]

async function loadMetrics() {
  loading.value = true
  error.value = null
  try {
    metrics.value = await api.metrics.get(selectedDays.value)
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Failed to load metrics'
  } finally {
    loading.value = false
  }
}

onMounted(loadMetrics)
watch(selectedDays, loadMetrics)

function resolveAgentName(agentId: string): string {
  return agentDefs.agents.find(a => a.id === agentId)?.name ?? agentId.slice(0, 8)
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}

// ── Daily activity chart helpers ────────────────────────────────────────────

// ── Model usage: bar widths ─────────────────────────────────────────────────

const maxModelRequests = computed(() => {
  if (!metrics.value?.modelUsage.length) return 1
  return metrics.value.modelUsage[0].requestCount
})

// ── Tool usage: bar widths ──────────────────────────────────────────────────

const maxToolCalls = computed(() => {
  if (!metrics.value?.toolUsage.length) return 1
  return metrics.value.toolUsage[0].callCount
})

const memoryModelUsage = computed(() => metrics.value?.auxiliaryModelUsage
  .filter(item => ['embedding', 'reranker', 'deep-research'].includes(item.kind)) ?? [])
const autoRoutingUsage = computed(() => metrics.value?.auxiliaryModelUsage
  .filter(item => item.kind === 'task-context' || item.kind === 'memory-router' || item.kind === 'tool-router') ?? [])
const cacheHitPercent = computed(() => {
  const totals = metrics.value?.totals
  return totals?.promptTokens ? Math.round((totals.cacheReadTokens / totals.promptTokens) * 100) : 0
})
const maxMemoryRequests = computed(() => Math.max(1, ...memoryModelUsage.value.map(item => item.requestCount)))
const maxAutoRoutingRequests = computed(() => Math.max(1, ...autoRoutingUsage.value.map(item => item.requestCount)))

function auxiliaryKindLabel(kind: MetricsSummary['auxiliaryModelUsage'][number]['kind']): string {
  if (kind === 'embedding') return 'Embedding'
  if (kind === 'reranker') return 'Reranker'
  if (kind === 'deep-research') return 'Deep Research'
  if (kind === 'task-context') return 'Task context'
  if (kind === 'memory-router') return 'Memory routing'
  if (kind === 'tool-router') return 'Tool routing'
  return 'Dreaming'
}

function formatCost(cost: number | null): string {
  if (cost === null) return '—'
  if (cost < 0.01) return '<$0.01'
  if (cost < 1) return '$' + cost.toFixed(2)
  return '$' + cost.toFixed(2)
}

const showResetModal = ref(false)
const resetting = ref(false)
const resetError = ref('')

function openResetModal(): void {
  resetError.value = ''
  showResetModal.value = true
}

async function confirmReset(): Promise<void> {
  resetting.value = true
  resetError.value = ''
  try {
    await api.metrics.reset()
    showResetModal.value = false
    await loadMetrics()
  } catch (error) {
    resetError.value = `Usage data was not reset: ${error instanceof Error ? error.message : 'unknown error'}`
  } finally {
    resetting.value = false
  }
}
</script>

<template>
  <!-- Period selector -->
  <div class="flex items-center justify-between mb-3">
    <h2 class="text-sm font-medium text-ink-secondary uppercase tracking-wider">
      Usage Metrics
    </h2>
    <div class="flex items-center gap-2">
      <div class="flex gap-1">
        <button
          v-for="d in dayOptions"
          :key="d"
          class="px-2.5 py-1 text-xs rounded-md transition-colors"
          :class="selectedDays === d
            ? 'bg-accent-600/20 text-accent-fg border border-accent-500/30'
            : 'text-ink-muted hover:text-theme-300 border border-transparent'"
          @click="selectedDays = d"
        >
          {{ d }}d
        </button>
      </div>
      <button
        class="flex items-center gap-1.5 px-2.5 py-1 text-xs text-ink-muted hover:text-status-danger border border-transparent hover:border-red-500/30 hover:bg-red-500/10 rounded-md transition-colors"
        title="Reset usage metrics"
        @click="openResetModal"
      >
        <Icon
          icon="lucide:rotate-ccw"
          class="w-3.5 h-3.5"
        />
        Reset
      </button>
    </div>
  </div>

  <!-- Reset confirmation modal -->
  <ModalDialog
    :show="showResetModal"
    title="Reset Usage Metrics"
    icon="lucide:rotate-ccw"
    icon-color="red"
    @close="showResetModal = false"
  >
    <p class="text-sm text-ink-secondary">
      This will clear all recorded usage data up to this point. New metrics will be tracked from now on. Your chat history is not affected.
    </p>
    <p
      v-if="resetError"
      class="mt-3 rounded-lg border border-red-400/25 bg-red-400/10 px-3 py-2 text-xs text-status-danger"
      role="alert"
    >
      {{ resetError }}
    </p>
    <template #actions>
      <button
        :disabled="resetting"
        class="w-full px-4 py-2.5 bg-red-600 hover:bg-red-500 disabled:bg-theme-700 disabled:text-ink-muted text-white text-sm font-medium rounded-xl transition-colors"
        @click="confirmReset"
      >
        {{ resetting ? 'Resetting...' : 'Reset Usage' }}
      </button>
      <button
        class="w-full px-4 py-2.5 bg-theme-800 hover:bg-theme-700 text-theme-300 text-sm rounded-xl transition-colors border border-theme-700"
        @click="showResetModal = false"
      >
        Cancel
      </button>
    </template>
  </ModalDialog>

  <!-- Loading / Error -->
  <div
    v-if="loading"
    class="flex items-center justify-center py-12 text-ink-muted text-sm"
  >
    <Icon
      icon="lucide:loader-2"
      class="w-4 h-4 animate-spin mr-2"
    />
    Loading metrics…
  </div>
  <div
    v-else-if="error"
    class="text-status-danger text-sm py-6 text-center"
  >
    {{ error }}
  </div>

  <!-- Content -->
  <template v-else-if="metrics">
    <!-- Summary Cards -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
      <HoverTooltip>
        <BaseCard class="p-4 w-full">
          <div class="text-[11px] text-ink-muted uppercase tracking-wider mb-1">
            Conversations
          </div>
          <div class="text-xl font-semibold text-theme-100">
            {{ formatNumber(metrics.totals.conversations) }}
          </div>
        </BaseCard>
        <template #content>
          <div class="font-medium text-theme-300 mb-1">
            Conversations
          </div>
          <div class="text-ink-secondary">
            Total: {{ metrics.totals.conversations.toLocaleString() }}
          </div>
          <div class="text-ink-muted text-[10px] mt-1">
            Unique chat sessions in the selected period
          </div>
        </template>
      </HoverTooltip>
      <HoverTooltip>
        <BaseCard class="p-4 w-full">
          <div class="text-[11px] text-ink-muted uppercase tracking-wider mb-1">
            Messages
          </div>
          <div class="text-xl font-semibold text-theme-100">
            {{ formatNumber(metrics.totals.messages) }}
          </div>
        </BaseCard>
        <template #content>
          <div class="font-medium text-theme-300 mb-1">
            Messages
          </div>
          <div class="text-ink-secondary">
            Total: {{ metrics.totals.messages.toLocaleString() }}
          </div>
          <div class="text-ink-muted text-[10px] mt-1">
            User + assistant messages across all conversations
          </div>
        </template>
      </HoverTooltip>
      <HoverTooltip>
        <BaseCard class="p-4 w-full">
          <div class="text-[11px] text-ink-muted uppercase tracking-wider mb-1">
            Total Tokens
          </div>
          <div class="text-xl font-semibold text-theme-100">
            {{ formatNumber(metrics.totals.totalTokens) }}
          </div>
          <div class="text-[10px] text-ink-faint mt-0.5">
            {{ formatNumber(metrics.totals.promptTokens) }} in · {{ formatNumber(metrics.totals.completionTokens) }} out
          </div>
        </BaseCard>
        <template #content>
          <div class="font-medium text-theme-300 mb-1">
            Token Usage
          </div>
          <div class="flex justify-between text-ink-secondary mb-0.5">
            <span>Prompt (input)</span><span class="text-theme-300">{{ metrics.totals.promptTokens.toLocaleString() }}</span>
          </div>
          <div class="flex justify-between text-ink-secondary mb-0.5 pl-2">
            <span>Cache reads</span><span class="text-theme-300">{{ metrics.totals.cacheReadTokens.toLocaleString() }} ({{ cacheHitPercent }}%)</span>
          </div>
          <div class="flex justify-between text-ink-secondary mb-0.5 pl-2">
            <span>Cache writes</span><span class="text-theme-300">{{ metrics.totals.cacheWriteTokens.toLocaleString() }}</span>
          </div>
          <div class="flex justify-between text-ink-secondary mb-0.5">
            <span>Completion (output)</span><span class="text-theme-300">{{ metrics.totals.completionTokens.toLocaleString() }}</span>
          </div>
          <div class="flex justify-between text-ink-secondary border-t border-theme-800 pt-1 mt-1">
            <span>Total</span><span class="text-theme-200 font-medium">{{ metrics.totals.totalTokens.toLocaleString() }}</span>
          </div>
        </template>
      </HoverTooltip>
      <HoverTooltip>
        <BaseCard class="p-4 w-full">
          <div class="text-[11px] text-ink-muted uppercase tracking-wider mb-1">
            Est. Cost
          </div>
          <div
            class="text-xl font-semibold"
            :class="metrics.totals.estimatedCost !== null ? 'text-status-warning' : 'text-ink-muted'"
          >
            {{ formatCost(metrics.totals.estimatedCost) }}
          </div>
          <div class="text-[10px] text-ink-faint mt-0.5">
            {{ metrics.totals.avgLatencyMs.toLocaleString() }}ms avg latency
          </div>
        </BaseCard>
        <template #content>
          <div class="font-medium text-theme-300 mb-1">
            Cost &amp; Latency
          </div>
          <div class="flex justify-between text-ink-secondary mb-0.5">
            <span>Estimated cost</span><span class="text-status-warning">{{ formatCost(metrics.totals.estimatedCost) }}</span>
          </div>
          <div class="flex justify-between text-ink-secondary mb-0.5">
            <span>Chat models</span><span class="text-theme-300">{{ formatCost(metrics.totals.chatEstimatedCost) }}</span>
          </div>
          <div class="flex justify-between text-ink-secondary mb-0.5">
            <span>Memory</span><span class="text-theme-300">{{ formatCost(metrics.totals.memoryEstimatedCost) }}</span>
          </div>
          <div class="flex justify-between text-ink-secondary mb-0.5">
            <span>Auto routing</span><span class="text-theme-300">{{ formatCost(metrics.totals.autoRoutingEstimatedCost) }}</span>
          </div>
          <div class="flex justify-between text-ink-secondary mb-0.5">
            <span>Dreaming</span><span class="text-theme-300">{{ formatCost(metrics.totals.dreamingEstimatedCost) }}</span>
          </div>
          <div class="flex justify-between text-ink-secondary">
            <span>Avg latency</span><span class="text-theme-300">{{ metrics.totals.avgLatencyMs.toLocaleString() }}ms</span>
          </div>
          <div class="text-ink-muted text-[10px] mt-1">
            Cost estimates via models.dev pricing data
          </div>
        </template>
      </HoverTooltip>
    </div>

    <!-- Cost attribution -->
    <p
      v-if="metrics.totals.estimatedCost !== null"
      class="text-[10px] text-ink-faint mb-4 -mt-4 text-right"
    >
      Cost estimates via
      <a
        href="https://models.dev"
        target="_blank"
        rel="noopener noreferrer"
        class="text-ink-muted hover:text-ink-secondary underline underline-offset-2"
      >models.dev</a>
      pricing
    </p>

    <!-- Daily Activity Chart -->
    <DailyActivityChart
      v-if="metrics.dailyActivity.length"
      :data="metrics.dailyActivity"
      :days="selectedDays"
    />

    <!-- Usage breakdown -->
    <div class="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
      <!-- Model Usage -->
      <BaseCard class="p-4">
        <h3 class="text-xs font-medium text-ink-secondary mb-3">
          Agent Models
        </h3>
        <div
          v-if="!metrics.modelUsage.length"
          class="text-xs text-ink-faint py-4 text-center"
        >
          No model data
        </div>
        <div
          v-else
          class="space-y-2"
        >
          <div
            v-for="m in metrics.modelUsage.slice(0, 8)"
            :key="m.provider + m.model"
          >
            <div class="flex items-center justify-between text-xs mb-0.5">
              <span class="text-theme-300 truncate mr-2">{{ m.model }}</span>
              <span class="text-ink-muted shrink-0">{{ formatNumber(m.requestCount) }} reqs</span>
            </div>
            <div class="w-full h-1.5 bg-theme-800 rounded-full overflow-hidden">
              <div
                class="h-full bg-emerald-500/70 rounded-full"
                :style="{ width: (m.requestCount / maxModelRequests * 100) + '%' }"
              />
            </div>
            <div class="text-[10px] text-ink-faint mt-0.5">
              {{ m.provider }} · {{ formatNumber(m.totalPromptTokens + m.totalCompletionTokens) }} tokens
              <span
                v-if="m.estimatedCost !== null"
                class="text-status-warning/80 ml-1"
              >· {{ formatCost(m.estimatedCost) }}</span>
            </div>
          </div>
        </div>
      </BaseCard>

      <!-- Memory model usage -->
      <BaseCard class="p-4">
        <h3 class="text-xs font-medium text-ink-secondary mb-3">
          Memory
        </h3>
        <div
          v-if="!memoryModelUsage.length"
          class="text-xs text-ink-faint py-4 text-center"
        >
          No memory model data
        </div>
        <div
          v-else
          class="space-y-2"
        >
          <div
            v-for="m in memoryModelUsage.slice(0, 8)"
            :key="m.kind + m.provider + m.model"
          >
            <div class="flex items-center justify-between text-xs mb-0.5">
              <span class="text-theme-300 truncate mr-2">{{ m.model }}</span>
              <span class="text-ink-muted shrink-0">{{ formatNumber(m.requestCount) }} reqs</span>
            </div>
            <div class="w-full h-1.5 bg-theme-800 rounded-full overflow-hidden">
              <div
                class="h-full bg-sky-500/70 rounded-full"
                :style="{ width: (m.requestCount / maxMemoryRequests * 100) + '%' }"
              />
            </div>
            <div class="text-[10px] text-ink-faint mt-0.5">
              {{ auxiliaryKindLabel(m.kind) }} · {{ m.provider }} · {{ formatNumber(m.totalPromptTokens + m.totalCompletionTokens) }} tokens
              <span
                v-if="m.estimatedCost !== null"
                class="text-status-warning/80 ml-1"
              >· {{ formatCost(m.estimatedCost) }}</span>
            </div>
          </div>
        </div>
      </BaseCard>

      <!-- Pre-agent auto-routing usage -->
      <BaseCard class="p-4">
        <h3 class="text-xs font-medium text-ink-secondary mb-3">
          Auto Routing
        </h3>
        <div
          v-if="!autoRoutingUsage.length"
          class="text-xs text-ink-faint py-4 text-center"
        >
          No auto-routing data
        </div>
        <div
          v-else
          class="space-y-2"
        >
          <div
            v-for="m in autoRoutingUsage.slice(0, 8)"
            :key="m.kind + m.provider + m.model"
          >
            <div class="flex items-center justify-between text-xs mb-0.5">
              <span class="text-theme-300 truncate mr-2">{{ m.model }}</span>
              <span class="text-ink-muted shrink-0">{{ formatNumber(m.requestCount) }} reqs</span>
            </div>
            <div class="w-full h-1.5 bg-theme-800 rounded-full overflow-hidden">
              <div
                class="h-full bg-cyan-500/70 rounded-full"
                :style="{ width: (m.requestCount / maxAutoRoutingRequests * 100) + '%' }"
              />
            </div>
            <div class="text-[10px] text-ink-faint mt-0.5">
              {{ auxiliaryKindLabel(m.kind) }} · {{ m.provider }} · {{ formatNumber(m.totalPromptTokens + m.totalCompletionTokens) }} tokens
              <span
                v-if="m.estimatedCost !== null"
                class="text-status-warning/80 ml-1"
              >· {{ formatCost(m.estimatedCost) }}</span>
            </div>
          </div>
        </div>
      </BaseCard>

      <!-- Tool Usage -->
      <BaseCard class="p-4">
        <h3 class="text-xs font-medium text-ink-secondary mb-3">
          Tool Usage
        </h3>
        <div
          v-if="!metrics.toolUsage.length"
          class="text-xs text-ink-faint py-4 text-center"
        >
          No tool data
        </div>
        <div
          v-else
          class="space-y-2"
        >
          <div
            v-for="t in metrics.toolUsage.slice(0, 10)"
            :key="t.toolName"
          >
            <div class="flex items-center justify-between text-xs mb-0.5">
              <span class="text-theme-300 truncate mr-2 font-mono text-[11px]">{{ t.toolName }}</span>
              <span class="text-ink-muted shrink-0">{{ formatNumber(t.callCount) }}</span>
            </div>
            <div class="w-full h-1.5 bg-theme-800 rounded-full overflow-hidden">
              <div
                class="h-full bg-violet-500/70 rounded-full"
                :style="{ width: (t.callCount / maxToolCalls * 100) + '%' }"
              />
            </div>
          </div>
        </div>
      </BaseCard>
    </div>

    <!-- Two-column: Agents + Origins -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <!-- Agent Usage -->
      <BaseCard class="p-4">
        <h3 class="text-xs font-medium text-ink-secondary mb-3">
          Agent Usage
        </h3>
        <div
          v-if="!metrics.agentUsage.length"
          class="text-xs text-ink-faint py-4 text-center"
        >
          No agent data
        </div>
        <div
          v-else
          class="divide-y divide-theme-800/60"
        >
          <div
            v-for="a in metrics.agentUsage.slice(0, 8)"
            :key="a.agentId"
            class="flex items-center justify-between py-1.5 first:pt-0 last:pb-0"
          >
            <span class="text-xs text-theme-300 truncate mr-2">{{ resolveAgentName(a.agentId) }}</span>
            <div class="flex items-center gap-3 shrink-0 text-[11px]">
              <span class="text-ink-muted">{{ a.conversationCount }} convos</span>
              <span class="text-ink-faint">{{ formatNumber(a.messageCount) }} msgs</span>
            </div>
          </div>
        </div>
      </BaseCard>

      <!-- Origin Breakdown -->
      <BaseCard class="p-4">
        <h3 class="text-xs font-medium text-ink-secondary mb-3">
          Trigger Origins
        </h3>
        <div
          v-if="!metrics.originBreakdown.length"
          class="text-xs text-ink-faint py-4 text-center"
        >
          No origin data
        </div>
        <div
          v-else
          class="space-y-2"
        >
          <div
            v-for="o in metrics.originBreakdown"
            :key="o.origin"
            class="flex items-center justify-between"
          >
            <div class="flex items-center gap-2">
              <Icon
                :icon="o.origin === 'chat' ? 'lucide:message-circle'
                  : o.origin === 'heartbeat' ? 'lucide:heart-pulse'
                    : o.origin === 'webhook' ? 'lucide:webhook'
                      : o.origin === 'cron' ? 'lucide:clock'
                        : o.origin === 'dreaming' ? 'lucide:moon-star'
                          : o.origin === 'discord' ? 'simple-icons:discord'
                            : o.origin === 'slack' ? 'simple-icons:slack'
                              : 'lucide:zap'"
                class="w-3.5 h-3.5 text-ink-muted"
              />
              <span class="text-xs text-theme-300 capitalize">{{ o.origin }}</span>
            </div>
            <span class="text-xs text-ink-muted">{{ formatNumber(o.count) }}</span>
          </div>
        </div>
      </BaseCard>
    </div>
  </template>
</template>
