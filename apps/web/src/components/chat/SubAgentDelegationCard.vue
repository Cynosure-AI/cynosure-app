<script setup lang="ts">
/**
 * One card per delegation: who was asked, what each sub-agent is doing or
 * found, and the transcript of each run on demand. A single run is the card
 * itself; parallel runs become rows under a summary header.
 */
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import { useToolPresentation } from '../../composables/useToolPresentation'
import ToolExecutionList from './ToolExecutionList.vue'
import {
  DELEGATION_TOOLS,
  toolResultsById,
  uniqueToolCalls,
  type DelegationEntry,
  type SubAgentRun,
} from '../../utils/delegation-timeline'

type RunStatus = 'starting' | 'running' | 'queued' | 'finished' | 'returned' | 'failed' | 'awaiting' | 'denied' | 'ended'

const props = defineProps<{
  delegation: DelegationEntry
  /** The conversation's agent is still executing. */
  isExecuting: boolean
  /** The run whose work is happening right now, if known. */
  liveRunKey: string | null
  /** The delegation call itself is the active tool step. */
  isCallActive: boolean
  isRunExpanded: (key: string) => boolean
}>()

const emit = defineEmits<{
  toggleRun: [key: string]
  registerScroll: [key: string, el: unknown]
  previewImage: [src: string]
}>()

defineSlots<{ run(props: { run: SubAgentRun }): unknown }>()

const agentDefs = useAgentDefinitionsStore()
const { toolDisplayName, toolNamespaceIcon, toolIconUrl, isBuiltInTool } = useToolPresentation()
const fullHeightRuns = reactive(new Set<string>())
const otherToolsOpen = ref(false)

const runs = computed(() => props.delegation.runs)
const isParallel = computed(() => runs.value.length > 1)

function agentFor(run: SubAgentRun) {
  return (run.agentId ? agentDefs.get(run.agentId) : undefined)
    ?? agentDefs.agents.find((agent) => agent.internalName === run.codename)
}

function displayName(run: SubAgentRun): string {
  return run.agentName || agentFor(run)?.name || run.codename
}

function iconUrl(run: SubAgentRun): string | null {
  return agentFor(run)?.iconUrl ?? null
}

// ─── Status ─────────────────────────────────────────────────

/** Approval and denial apply to the whole call. */
const callStatus = computed(() => props.delegation.call?.group.steps.at(-1)?.status)

/**
 * Tool calls run one after another, so the run doing work right now splits
 * the list: earlier runs have finished and later ones are queued. Results for
 * every run arrive together once the last one returns.
 */
const liveIndex = computed(() => {
  const live = runs.value.findIndex((run) => run.key === props.liveRunKey)
  if (live >= 0) return live
  for (let index = runs.value.length - 1; index > 0; index--) {
    if (runs.value[index].entries.length) return index
  }
  return 0
})

const statuses = computed<RunStatus[]>(() => runs.value.map((run, index) => {
  if (run.result) return run.result.success === false ? 'failed' : 'returned'
  if (callStatus.value === 'denied') return 'denied'
  if (!props.isExecuting) return 'ended'
  if (callStatus.value === 'awaiting-approval') return 'awaiting'
  if (index < liveIndex.value) return 'finished'
  if (index > liveIndex.value) return 'queued'
  return run.entries.length ? 'running' : 'starting'
}))

const STATUS_META: Record<RunStatus, { label: string; icon: string; tone: string }> = {
  starting: { label: 'Starting', icon: 'svg-spinners:ring-resize', tone: 'text-accent-fg' },
  running: { label: 'Working', icon: 'svg-spinners:ring-resize', tone: 'text-accent-fg' },
  queued: { label: 'Queued', icon: 'lucide:clock', tone: 'text-ink-faint' },
  finished: { label: 'Finished', icon: 'lucide:check', tone: 'text-ink-secondary' },
  returned: { label: 'Returned', icon: 'lucide:circle-check', tone: 'text-status-success' },
  failed: { label: 'Failed', icon: 'lucide:circle-x', tone: 'text-status-danger' },
  awaiting: { label: 'Awaiting approval', icon: 'lucide:shield-question', tone: 'text-status-warning' },
  denied: { label: 'Denied', icon: 'lucide:shield-x', tone: 'text-status-danger' },
  ended: { label: 'Ended', icon: 'lucide:circle-minus', tone: 'text-ink-faint' },
}

const isLive = (status: RunStatus) => status === 'running' || status === 'starting'
const anyLive = computed(() => statuses.value.some(isLive))
const doneCount = computed(() => statuses.value.filter((status) => status === 'returned' || status === 'finished').length)

const summaryStatus = computed<RunStatus>(() => {
  const all = statuses.value
  if (all.some(isLive)) return 'running'
  for (const status of ['awaiting', 'denied', 'failed', 'queued', 'ended'] as const) {
    if (all.includes(status)) return status
  }
  return 'returned'
})

// ─── What each run is doing / found ─────────────────────────

/** First readable line of markdown-ish text. */
function firstLine(value: string | undefined): string {
  for (const line of (value || '').split('\n')) {
    const clean = line.replace(/^[#>*\-\d.\s|`]+/, '').replace(/[*_`]/g, '').trim()
    if (clean) return clean
  }
  return ''
}

function resultSummary(run: SubAgentRun): string {
  const result = run.result
  if (!result) return ''
  if (result.success === false) return firstLine(result.error || result.output) || 'The sub-agent could not complete the task.'
  const structured = result.structuredContent as { response?: unknown } | undefined
  if (structured && typeof structured.response === 'string') return firstLine(structured.response)
  return firstLine(result.output.replace(/^Sub-agent invocation ID: .*\n+/, ''))
}

function latestAnswer(run: SubAgentRun): string {
  for (let i = run.entries.length - 1; i >= 0; i--) {
    const entry = run.entries[i]
    if (entry.type === 'message' && entry.msg.role === 'assistant' && entry.msg.content) return firstLine(entry.msg.content)
  }
  return ''
}

function toolNames(names: string[]): string {
  const unique = [...new Set(names.map((name) => toolDisplayName(name)))]
  if (!unique.length) return ''
  return unique.length > 2 ? `${unique.slice(0, 2).join(', ')} +${unique.length - 2}` : unique.join(', ')
}

function liveActivity(run: SubAgentRun): string {
  const last = run.entries.at(-1)
  if (!last) return 'Getting ready…'
  if (last.type === 'message' && last.msg.role === 'assistant') {
    if (last.msg.isStreaming && !last.msg.content) return last.msg.thinking ? 'Thinking…' : 'Writing…'
    return firstLine(last.msg.content) || 'Writing…'
  }
  if (last.type === 'tool-group') {
    if (last.group.iteration === 0) return 'Gathering context…'
    const names = toolNames(uniqueToolCalls(last).map((call) => call.name))
    return names ? `Using ${names}` : 'Working…'
  }
  if (last.type === 'saved-tool-result') return `Used ${toolDisplayName(last.call?.name)}`
  return 'Working…'
}

function activity(run: SubAgentRun, status: RunStatus): string {
  switch (status) {
    case 'running':
    case 'starting':
      return liveActivity(run)
    case 'queued':
      return firstLine(run.openingMessage ?? '') || 'Waiting for its turn'
    case 'awaiting':
      return 'Waiting for your approval to delegate'
    case 'denied':
      return 'Delegation was denied'
    case 'failed':
      return resultSummary(run)
    default:
      return resultSummary(run) || latestAnswer(run) || (status === 'ended' ? 'Stopped before returning' : '')
  }
}

// ─── Timing ─────────────────────────────────────────────────

const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
watch(anyLive, (live) => {
  clearInterval(clock)
  clock = undefined
  if (!live) return
  now.value = Date.now()
  clock = setInterval(() => { now.value = Date.now() }, 1000)
}, { immediate: true })
onBeforeUnmount(() => clearInterval(clock))

function lastActivityAt(run: SubAgentRun): number | undefined {
  const last = run.entries.at(-1)
  if (!last) return undefined
  if (last.type === 'tool-group') {
    const step = last.group.steps.at(-1)
    return step ? Math.max(step.updatedAt ?? step.timestamp, step.resultsAt ?? 0) : last.ts
  }
  return last.ts
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

function elapsed(run: SubAgentRun, status: RunStatus): string {
  const start = run.entries[0]?.ts
  const end = isLive(status) ? now.value : lastActivityAt(run)
  if (start === undefined || end === undefined || end - start < 1000) return ''
  return formatDuration(end - start)
}

function stepsLabel(run: SubAgentRun): string {
  return `${run.entries.length} step${run.entries.length === 1 ? '' : 's'}`
}

// ─── Other tools requested alongside the delegation ─────────

const otherToolRows = computed(() => {
  const call = props.delegation.call
  if (!call) return []
  const results = toolResultsById(call)
  return uniqueToolCalls(call).filter((toolCall) => !DELEGATION_TOOLS.has(toolCall.name)).map((toolCall) => ({
    call: { name: toolCall.name, arguments: toolCall.arguments },
    result: toolCall.id ? results.get(toolCall.id) : undefined,
    name: toolDisplayName(toolCall.name),
    icon: toolNamespaceIcon(toolCall.name),
    iconUrl: toolIconUrl(toolCall.name),
    internal: isBuiltInTool(toolCall.name),
  }))
})

const summaryLabel = computed(() => {
  const count = runs.value.length
  const continued = runs.value.every((run) => run.continued)
  return `${continued ? 'Continued' : 'Delegated to'} ${count} sub-agents`
})

function toggleFullHeight(key: string): void {
  if (fullHeightRuns.has(key)) fullHeightRuns.delete(key)
  else fullHeightRuns.add(key)
}

function toggleRun(key: string): void {
  if (props.isRunExpanded(key)) fullHeightRuns.delete(key)
  emit('toggleRun', key)
}
</script>

<template>
  <div class="mx-3 my-2 md:mx-4">
    <section
      class="delegation-card overflow-hidden rounded-2xl border bg-theme-800/25 transition-colors duration-500"
      :class="anyLive ? 'border-accent-500/35' : 'border-theme-700/60'"
      :aria-label="isParallel ? summaryLabel : `Delegated to ${displayName(runs[0])}`"
      data-testid="delegation-card"
    >
      <!-- Parallel runs: summary header -->
      <header
        v-if="isParallel"
        class="flex items-center gap-3 border-b border-theme-700/40 px-3 py-2.5"
      >
        <div class="flex shrink-0 -space-x-2">
          <span
            v-for="run in runs.slice(0, 3)"
            :key="run.key"
            class="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full bg-theme-800 ring-2 ring-theme-900"
          >
            <img
              v-if="iconUrl(run)"
              :src="iconUrl(run)!"
              alt=""
              class="h-full w-full object-cover"
            >
            <Icon
              v-else
              icon="lucide:bot"
              class="h-3.5 w-3.5 text-ink-secondary"
            />
          </span>
        </div>
        <span class="min-w-0 flex-1 truncate text-[13px] font-medium text-theme-200">{{ summaryLabel }}</span>
        <span
          class="flex shrink-0 items-center gap-1.5 text-[11px]"
          :class="STATUS_META[summaryStatus].tone"
        >
          <Icon
            :icon="STATUS_META[summaryStatus].icon"
            class="h-3.5 w-3.5"
          />
          <span class="tabular-nums">{{ doneCount }}/{{ runs.length }} done</span>
        </span>
        <!-- Progress across runs -->
        <span
          class="hidden h-1 w-16 shrink-0 overflow-hidden rounded-full bg-theme-700/60 sm:block"
          role="progressbar"
          :aria-valuenow="doneCount"
          :aria-valuemax="runs.length"
          aria-label="Sub-agents done"
        >
          <span
            class="block h-full rounded-full bg-accent-500 transition-[width] duration-500 ease-out"
            :style="{ width: `${(doneCount / runs.length) * 100}%` }"
          />
        </span>
      </header>

      <div :class="{ 'divide-y divide-theme-700/35': isParallel }">
        <div
          v-for="(run, index) in runs"
          :key="run.key"
        >
          <!-- Run row -->
          <div
            role="button"
            tabindex="0"
            class="group/run flex w-full cursor-pointer items-center gap-3 px-3 text-left transition-colors hover:bg-theme-700/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500/60"
            :class="isParallel ? 'py-2' : 'py-2.5'"
            :aria-expanded="isRunExpanded(run.key)"
            :aria-label="`${isRunExpanded(run.key) ? 'Collapse' : 'Expand'} ${displayName(run)} sub-agent steps`"
            @click="toggleRun(run.key)"
            @keydown.enter.self.prevent="toggleRun(run.key)"
            @keydown.space.self.prevent="toggleRun(run.key)"
          >
            <span
              class="run-avatar relative flex shrink-0 items-center justify-center rounded-full bg-theme-800 ring-1 ring-theme-600/60"
              :class="[isParallel ? 'h-7 w-7' : 'h-8 w-8', { 'run-avatar--live': isLive(statuses[index]) }]"
            >
              <span class="flex h-full w-full items-center justify-center overflow-hidden rounded-full">
                <img
                  v-if="iconUrl(run)"
                  :src="iconUrl(run)!"
                  alt=""
                  class="h-full w-full object-cover"
                >
                <Icon
                  v-else
                  icon="lucide:bot"
                  class="h-4 w-4 text-ink-secondary"
                />
              </span>
            </span>

            <span class="min-w-0 flex-1">
              <span class="flex min-w-0 items-baseline gap-1.5">
                <span class="truncate text-[13px] font-medium text-theme-200">{{ displayName(run) }}</span>
                <span
                  v-if="displayName(run) !== run.codename"
                  class="hidden shrink-0 truncate text-[10px] text-ink-faint sm:inline"
                >{{ run.codename }}</span>
                <span
                  v-if="run.continued"
                  class="inline-flex shrink-0 items-center gap-1 self-center rounded-md border border-theme-600/50 bg-theme-700/30 px-1.5 py-px text-[10px] text-ink-secondary"
                  title="Continues an earlier session with this sub-agent"
                >
                  <Icon
                    icon="lucide:history"
                    class="h-2.5 w-2.5"
                  />
                  Continued
                </span>
              </span>
              <span
                v-if="activity(run, statuses[index])"
                class="mt-0.5 grid min-w-0 overflow-hidden text-[11px]"
                :class="statuses[index] === 'failed' || statuses[index] === 'denied' ? 'text-status-danger' : 'text-ink-muted'"
                :title="activity(run, statuses[index])"
                role="status"
              >
                <Transition
                  enter-active-class="transition duration-300 ease-out"
                  enter-from-class="opacity-0 translate-y-1"
                  leave-active-class="transition duration-200 ease-in"
                  leave-to-class="opacity-0 -translate-y-1"
                >
                  <span
                    :key="`${statuses[index]}-${isLive(statuses[index]) ? run.entries.length : ''}`"
                    class="col-start-1 row-start-1 truncate"
                    :class="{ 'text-shimmer': isLive(statuses[index]) }"
                  >{{ activity(run, statuses[index]) }}</span>
                </Transition>
              </span>
            </span>

            <span
              class="hidden shrink-0 items-center gap-1 text-[11px] sm:flex"
              :class="STATUS_META[statuses[index]].tone"
            >
              <Icon
                :icon="STATUS_META[statuses[index]].icon"
                class="h-3.5 w-3.5"
              />
              {{ STATUS_META[statuses[index]].label }}
            </span>
            <Icon
              :icon="STATUS_META[statuses[index]].icon"
              class="h-3.5 w-3.5 shrink-0 sm:hidden"
              :class="STATUS_META[statuses[index]].tone"
              :aria-label="STATUS_META[statuses[index]].label"
              role="img"
            />
            <span
              v-if="elapsed(run, statuses[index])"
              class="shrink-0 text-[10px] tabular-nums text-ink-faint"
            >{{ elapsed(run, statuses[index]) }}</span>
            <span
              v-if="run.entries.length"
              class="hidden shrink-0 text-[10px] tabular-nums text-ink-faint md:inline"
            >{{ stepsLabel(run) }}</span>
            <button
              v-if="isRunExpanded(run.key) && run.entries.length"
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-theme-700/40 hover:text-theme-200"
              :title="fullHeightRuns.has(run.key) ? 'Collapse to compact view' : 'Expand to full height'"
              @click.stop="toggleFullHeight(run.key)"
            >
              <Icon
                :icon="fullHeightRuns.has(run.key) ? 'lucide:minimize-2' : 'lucide:maximize-2'"
                class="h-3.5 w-3.5"
              />
            </button>
            <Icon
              icon="lucide:chevron-down"
              class="h-4 w-4 shrink-0 text-ink-faint transition-transform duration-200"
              :class="{ 'rotate-180': isRunExpanded(run.key) }"
            />
          </div>

          <!-- Run transcript -->
          <Transition
            enter-active-class="transition duration-200 ease-out"
            enter-from-class="opacity-0 -translate-y-1"
            leave-active-class="transition duration-150 ease-in"
            leave-to-class="opacity-0 -translate-y-1"
          >
            <div
              v-if="isRunExpanded(run.key)"
              :ref="(el) => emit('registerScroll', run.key, el)"
              class="overflow-y-auto border-t border-theme-700/40 py-2"
              :class="[fullHeightRuns.has(run.key) ? '' : 'max-h-80', { 'bg-theme-950/20': isParallel }]"
            >
              <slot
                name="run"
                :run="run"
              />
              <p
                v-if="!run.entries.length"
                class="px-4 pb-1 text-xs text-ink-muted"
              >
                {{ statuses[index] === 'queued' ? 'Starts after the sub-agents before it finish.' : 'No activity recorded.' }}
              </p>
            </div>
          </Transition>
        </div>
      </div>

      <!-- Other tools the main agent called in the same step -->
      <div
        v-if="otherToolRows.length"
        class="border-t border-theme-700/40"
      >
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] text-ink-muted transition-colors hover:bg-theme-700/20 hover:text-theme-200"
          :aria-expanded="otherToolsOpen"
          @click="otherToolsOpen = !otherToolsOpen"
        >
          <Icon
            icon="lucide:wrench"
            class="h-3 w-3"
          />
          <span>Also ran {{ otherToolRows.length }} tool{{ otherToolRows.length === 1 ? '' : 's' }}</span>
          <span class="min-w-0 truncate text-ink-faint">· {{ otherToolRows.map((row) => row.name).join(', ') }}</span>
          <Icon
            icon="lucide:chevron-down"
            class="ml-auto h-3.5 w-3.5 shrink-0 transition-transform duration-200"
            :class="{ 'rotate-180': otherToolsOpen }"
          />
        </button>
        <div
          v-if="otherToolsOpen"
          class="px-3 pb-3"
        >
          <ToolExecutionList
            :rows="otherToolRows"
            :is-active="isCallActive"
            status="Executing"
            @preview-image="emit('previewImage', $event)"
          />
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
@media (prefers-reduced-motion: no-preference) {
  /* A ring circles the avatar of the sub-agent doing the work. */
  .run-avatar--live::after {
    content: "";
    position: absolute;
    inset: -3px;
    border-radius: 9999px;
    padding: 1.5px;
    background: conic-gradient(from var(--run-ring-angle, 0deg), transparent 65%, var(--color-accent-fg));
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    animation: run-ring-spin 1.6s linear infinite;
  }
}

@property --run-ring-angle {
  syntax: "<angle>";
  inherits: false;
  initial-value: 0deg;
}

@keyframes run-ring-spin {
  to {
    --run-ring-angle: 360deg;
  }
}
</style>
