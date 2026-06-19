<script setup lang="ts">
import { ref, computed } from 'vue'
import { Icon } from '@iconify/vue'
import { usePreferencesStore } from '../../stores/preferences.store'
import CollapsibleSection from '../shared/CollapsibleSection.vue'
import FileArtifactLinks from './FileArtifactLinks.vue'
import { isInternalToolName } from '../../utils/internal-tools'

export interface ToolExecStep {
  iteration: number
  status: string
  message?: string
  toolCalls?: { name: string; arguments: string }[]
  results?: { name: string; success: boolean; output: string; error?: string; images?: string[] }[]
  streamingChoosing?: string
  timestamp: number
  taskId?: string
  maCodename?: string
  maAgentName?: string
  maInvocationId?: string
  maPhase?: string
}

const props = defineProps<{
  /** Iteration number (1-based) */
  iteration: number
  /** Execution steps for this iteration */
  steps: ToolExecStep[]
  /** Whether this iteration is actively executing */
  isActive: boolean
}>()

const prefs = usePreferencesStore()
const expanded = ref(prefs.autoExpandToolCalls)
const lightboxSrc = ref<string | null>(null)
const statusMeta: Record<string, { label: string; icon: string; color: string }> = {
  'building-task-context': { label: 'Preparing Context', icon: 'lucide:compass', color: 'text-cyan-600 dark:text-cyan-300' },
  'indexing-attachments': { label: 'Indexing Attachments', icon: 'lucide:paperclip', color: 'text-sky-600 dark:text-sky-300' },
  'routing-tools': { label: 'Gathering Tool Context', icon: 'lucide:route', color: 'text-accent-500 dark:text-accent-300' },
  'routing-memory': { label: 'Gathering Memory Context', icon: 'lucide:brain-circuit', color: 'text-accent-500 dark:text-accent-300' },
  'curating-tools': { label: 'Refining Tool Context', icon: 'lucide:list-filter', color: 'text-accent-500 dark:text-accent-300' },
  'curating-memory': { label: 'Refining Memory Context', icon: 'lucide:list-filter', color: 'text-accent-500 dark:text-accent-300' },
  'awaiting-approval': { label: 'Awaiting approval', icon: 'lucide:shield-question', color: 'text-amber-500 dark:text-amber-400' },
  denied: { label: 'Denied', icon: 'lucide:shield-x', color: 'text-red-500 dark:text-red-400' },
  executing: { label: 'Executing', icon: 'lucide:play', color: 'text-emerald-500 dark:text-emerald-400' },
  'ma-status': { label: 'Orchestrator', icon: 'lucide:network', color: 'text-violet-500 dark:text-violet-400' },
  'ma-subagent-running': { label: 'Sub-agent running', icon: 'lucide:bot', color: 'text-indigo-500 dark:text-indigo-400' },
  'ma-subagent-done': { label: 'Sub-agent done', icon: 'lucide:check', color: 'text-emerald-500 dark:text-emerald-400' },
  'ma-subagent-failed': { label: 'Sub-agent failed', icon: 'lucide:x', color: 'text-red-500 dark:text-red-400' },
  'ma-done': { label: 'Complete', icon: 'lucide:check-circle-2', color: 'text-emerald-500 dark:text-emerald-400' },
  'ma-error': { label: 'Error', icon: 'lucide:alert-circle', color: 'text-red-500 dark:text-red-400' },
  'ma-file': { label: 'File', icon: 'lucide:file-text', color: 'text-theme-400' },
  'memory-retrieved': { label: 'Memory retrieved', icon: 'lucide:brain', color: 'text-accent-500 dark:text-accent-300' },
}

type ToolCall = { name: string; arguments: string }
type ToolResult = { name: string; success: boolean; output: string; error?: string; images?: string[] }

function meta(s: string) {
  return statusMeta[s] ?? { label: s, icon: 'lucide:circle', color: 'text-theme-400' }
}

function isMemoryCall(call: { arguments: string }): boolean {
  try {
    return JSON.parse(call.arguments || '{}')?.type === 'memory'
  } catch {
    return false
  }
}

function isTaskContextCall(call: { name?: string; arguments: string }): boolean {
  try {
    const type = JSON.parse(call.arguments || '{}')?.type
    return type === 'task-context' || type === 'auto-router'
  } catch {
    return false
  }
}

function isAttachmentIndexCall(call: { arguments: string }): boolean {
  return parseToolCallArgs(call.arguments)?.type === 'attachment-index'
}

function contextPhase(call?: { arguments: string } | null): string {
  const phase = call ? parseToolCallArgs(call.arguments)?.contextPhase : undefined
  return typeof phase === 'string' ? phase : ''
}

function isContextGatheringCall(call: { arguments: string }): boolean {
  const parsed = parseToolCallArgs(call.arguments)
  return parsed?.type === 'memory' || parsed?.type === 'tool-router'
}

function isSubAgentSpawnCall(name: string): boolean {
  return name === 'spawn_subagent'
}

function toolDisplayName(name: string): string {
  if (name === 'Task context') return 'Preparing Context'
  return isSubAgentSpawnCall(name) ? 'Spawn sub-agent' : name
}

function parseToolCallArgs(args: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(args || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function formatRerankerScore(call: ToolCall): string | null {
  const parsed = parseToolCallArgs(call.arguments)
  const score = parsed?.rerankerScore
  if (typeof score !== 'number' || !Number.isFinite(score)) return null
  const normalized = score > 1 ? score / 100 : score
  return `${Math.round(Math.max(0, Math.min(1, normalized)) * 100)}%`
}

function formatToolRouterScore(call: ToolCall): string | null {
  const parsed = parseToolCallArgs(call.arguments)
  if (parsed?.type !== 'tool-router') return null
  const score = parsed.routerScore
  if (typeof score !== 'number' || !Number.isFinite(score)) return null
  const normalized = score > 1 ? score / 100 : score
  return `${Math.round(Math.max(0, Math.min(1, normalized)) * 100)}%`
}

function isToolRouterScoreCall(call?: ToolCall | null): boolean {
  if (!call) return false
  const parsed = parseToolCallArgs(call.arguments)
  return parsed?.type === 'tool-router' && typeof parsed.routerScore === 'number'
}

function memoryCallContent(call: ToolCall | null): string | null {
  if (!call || !isMemoryCall(call)) return null
  const content = parseToolCallArgs(call.arguments)?.content
  return typeof content === 'string' && content.trim() ? content.trim() : null
}

function memoryCallMetadata(call: ToolCall): string {
  const parsed = parseToolCallArgs(call.arguments)
  if (!parsed) return call.arguments
  const { content: _content, contextPhase: _contextPhase, ...metadata } = parsed
  return Object.keys(metadata).length ? JSON.stringify(metadata, null, 2) : ''
}

function toolRouterCallContent(call: ToolCall | null): string | null {
  if (!call) return null
  const parsed = parseToolCallArgs(call.arguments)
  if (parsed?.type !== 'tool-router') return null
  const content = parsed.content
  return typeof content === 'string' && content.trim() ? content.trim() : null
}

function subAgentCodenameFromArgs(args: string): string | null {
  try {
    const parsed = JSON.parse(args || '{}')
    return typeof parsed?.codename === 'string' && parsed.codename.trim()
      ? parsed.codename.trim()
      : null
  } catch {
    return null
  }
}

function toolChipClass(name: string): string {
  if (isInternalToolName(name)) return 'bg-purple-500/10 text-purple-600 ring-1 ring-purple-400/25 dark:text-purple-300 dark:ring-purple-500/20'
  if (name === 'Task context') return 'bg-cyan-200/40 text-cyan-700 ring-1 ring-cyan-400/25 dark:bg-cyan-500/10 dark:text-cyan-300 dark:ring-cyan-500/15'
  return isSubAgentSpawnCall(name)
    ? 'bg-indigo-200/40 text-indigo-700 ring-1 ring-indigo-400/30 dark:bg-indigo-500/15 dark:text-indigo-300 dark:ring-indigo-500/20'
    : 'bg-accent-200/40 text-accent-700 dark:bg-accent-500/10 dark:text-accent-300'
}

function toolCallIcon(call: { name: string; arguments: string }): string {
  if (isAttachmentIndexCall(call)) return 'lucide:paperclip'
  if (isTaskContextCall(call)) return 'lucide:compass'
  if (isSubAgentSpawnCall(call.name)) return 'lucide:bot'
  if (isMemoryCall(call)) return 'lucide:brain'
  return 'lucide:terminal'
}

function toolCallIconClass(name: string, args = ''): string {
  if (isAttachmentIndexCall({ arguments: args })) return 'text-sky-600 dark:text-sky-300'
  if (isTaskContextCall({ name, arguments: args })) return 'text-cyan-600 dark:text-cyan-300'
  if (isInternalToolName(name)) return 'text-purple-500 dark:text-purple-300'
  return isSubAgentSpawnCall(name) ? 'text-indigo-500 dark:text-indigo-400' : 'text-accent-500 dark:text-accent-400'
}

function isInternalExecution(execution: { call: ToolCall | null; result?: ToolResult }): boolean {
  return isInternalToolName(execution.call?.name || execution.result?.name)
}

function toolExecutionCardClass(execution: { call: ToolCall | null; result?: ToolResult }): string {
  if (isInternalExecution(execution)) {
    if (execution.result?.success === false) return 'bg-red-50/80 border-red-300/30 dark:bg-red-500/5 dark:border-red-500/15'
    return 'bg-purple-50/80 border-purple-300/30 dark:bg-purple-500/5 dark:border-purple-500/20'
  }
  if (execution.call && isSubAgentSpawnCall(execution.call.name)) {
    return 'bg-indigo-500/10 border-indigo-500/20 dark:bg-indigo-950/15 dark:border-indigo-500/25'
  }
  if (execution.result?.success === false) {
    return 'bg-red-50/80 border-red-300/30 dark:bg-red-500/5 dark:border-red-500/15'
  }
  return execution.result
    ? 'bg-emerald-50/80 border-emerald-300/30 dark:bg-emerald-500/5 dark:border-emerald-500/15'
    : 'bg-theme-950 border-theme-700 dark:bg-theme-900/60 dark:border-theme-700/30'
}

function toolExecutionNameClass(execution: { call: ToolCall | null; result?: ToolResult }): string {
  if (execution.result?.success === false) return 'text-red-600 dark:text-red-300'
  if (isInternalExecution(execution)) return 'text-purple-600 dark:text-purple-300'
  return execution.call && isSubAgentSpawnCall(execution.call.name)
    ? 'text-indigo-600 dark:text-indigo-300'
    : 'text-accent-500 dark:text-accent-300'
}

/** Current phase — the last meaningful status in this iteration */
const currentPhase = computed(() => {
  if (!props.steps.length) return meta('executing')
  const last = props.steps[props.steps.length - 1]
  return meta(last.status)
})

const currentStatus = computed(() => props.steps[props.steps.length - 1]?.status ?? 'executing')
const isTaskContext = computed(() => props.steps.some(step => step.status === 'building-task-context' || step.toolCalls?.some(isTaskContextCall)))
const isAttachmentIndexing = computed(() => props.steps.some(step => step.status === 'indexing-attachments' || step.toolCalls?.some(isAttachmentIndexCall)))
const isToolRouting = computed(() => currentStatus.value === 'routing-tools' || currentStatus.value === 'curating-tools')
const isMemoryRouting = computed(() => currentStatus.value === 'routing-memory' || currentStatus.value === 'curating-memory')
const isRoutingStatus = computed(() => isTaskContext.value || isAttachmentIndexing.value || isToolRouting.value || isMemoryRouting.value)

/** All tool names from this iteration */
const toolNames = computed(() => {
  for (const step of [...props.steps].reverse()) {
    if (step.toolCalls?.length) return step.toolCalls.map(tc => tc.name)
  }
  return []
})

const isSubAgentSpawnIteration = computed(() => toolNames.value.some(isSubAgentSpawnCall))

/** Latest results from this iteration */
const results = computed(() => {
  for (const step of [...props.steps].reverse()) {
    if (step.results?.length) {
      const visibleResults = prefs.showInternalToolCalls
          ? step.results
          : step.results.filter((result) => !isInternalToolName(result.name))
      if (visibleResults.length) return visibleResults
    }
  }
  return []
})

/** Tool call arguments from this iteration */
const rawToolCallArgs = computed(() => {
  for (const step of [...props.steps].reverse()) {
    if (step.toolCalls?.length) return step.toolCalls
  }
  return []
})

const toolCallArgs = computed(() => prefs.showInternalToolCalls
  ? rawToolCallArgs.value
  : rawToolCallArgs.value.filter((call) => isTaskContextCall(call) || !isInternalToolName(call.name))
)

function visibleToolCalls(calls: ToolCall[]): ToolCall[] {
  return prefs.showInternalToolCalls
    ? calls
    : calls.filter((call) => isTaskContextCall(call) || !isInternalToolName(call.name))
}

function buildExecutions(calls: ToolCall[], availableResults: ToolResult[] = []): Array<{ call: ToolCall | null; result?: ToolResult }> {
  const remainingResults = [...availableResults]
  const executions = calls.map((call, index) => {
    let resultIndex = remainingResults.findIndex(result => result.name === call.name)
    if (resultIndex === -1 && remainingResults[index]) resultIndex = index
    const result = resultIndex === -1 ? undefined : remainingResults.splice(resultIndex, 1)[0]
    return { call, result }
  })

  return [
    ...executions,
    ...remainingResults.map(result => ({ call: null, result })),
  ] as Array<{ call: ToolCall | null; result?: ToolResult }>
}

const toolExecutions = computed(() => {
  return buildExecutions(toolCallArgs.value, results.value)
})

const contextSections = computed(() => props.steps
  .filter((step) => step.toolCalls?.length && !step.toolCalls.some(isTaskContextCall))
  .map((step) => {
    const calls = visibleToolCalls(step.toolCalls || [])
    const firstCall = calls[0]
    return {
      status: step.status,
      phase: contextPhase(firstCall),
      calls,
      executions: buildExecutions(calls),
    }
  })
  .filter((section) => section.calls.some(isContextGatheringCall))
)

function contextSectionKind(section: { status: string }): 'tool' | 'memory' | null {
  if (section.status.endsWith('-tools')) return 'tool'
  if (section.status.endsWith('-memory')) return 'memory'
  return null
}

function contextSectionTitle(section: { status: string; phase: string }): string {
  const kind = contextSectionKind(section)
  const prefix = kind === 'tool' ? 'Tool' : kind === 'memory' ? 'Memory' : ''
  if (section.phase === 'gathered-results' || section.status === 'routing-tools' || section.status === 'routing-memory') {
    return prefix ? `Gathered ${prefix} Results` : 'Gathered Results'
  }
  if (section.phase === 'gathered-context' || section.status === 'curating-tools' || section.status === 'curating-memory') {
    return prefix ? `Gathered ${prefix} Context` : 'Gathered Context'
  }
  return meta(section.status).label
}

function contextSectionIcon(section: { status: string; phase: string }): string {
  if (section.phase === 'gathered-context' || section.status === 'curating-tools' || section.status === 'curating-memory') {
    return contextSectionKind(section) === 'memory' ? 'lucide:brain' : 'lucide:package-check'
  }
  return contextSectionKind(section) === 'memory' ? 'lucide:brain-circuit' : 'lucide:database'
}

function contextSectionClass(section: { status: string; phase: string }): string {
  return section.phase === 'gathered-context' || section.status === 'curating-tools' || section.status === 'curating-memory'
    ? 'border-emerald-400/25 bg-emerald-500/5'
    : 'border-accent-400/25 bg-accent-500/5'
}

const taskContext = computed(() => {
  const call = rawToolCallArgs.value.find(isTaskContextCall)
  if (!call) return null
  try {
    const parsed = JSON.parse(call.arguments || '{}') as {
      toolQuery?: unknown
      memoryQuery?: unknown
      content?: unknown
      emptyReason?: unknown
    }
    return {
      toolQuery: typeof parsed.toolQuery === 'string' ? parsed.toolQuery.trim() : '',
      memoryQuery: typeof parsed.memoryQuery === 'string' ? parsed.memoryQuery.trim() : '',
      content: typeof parsed.content === 'string' ? parsed.content.trim() : '',
      emptyReason: typeof parsed.emptyReason === 'string' ? parsed.emptyReason.trim() : '',
    }
  } catch {
    return null
  }
})

const taskContextQueries = computed(() => {
  if (!taskContext.value) return []
  const queries = [
    { label: 'Tools', value: taskContext.value.toolQuery },
    { label: 'Memory', value: taskContext.value.memoryQuery },
  ]
    .map((query) => ({ ...query, value: query.value.trim() }))
    .filter((query) => query.value)
  return queries
})

const taskContextQueryLabels = computed(() => taskContextQueries.value.map((query) => query.label))

const headerLabel = computed(() => {
  if (isTaskContext.value) return currentPhase.value.label
  if (isAttachmentIndexing.value) return currentPhase.value.label
  const latestSection = [...contextSections.value].reverse()[0]
  if (latestSection && latestSection.phase === 'gathered-context') return contextSectionTitle(latestSection)
  return currentPhase.value.label
})

/** Whether all results succeeded */
const allSuccess = computed(() => results.value.length > 0 && results.value.every(r => r.success))
const anyFailed = computed(() => results.value.some(r => !r.success))

/** Elapsed time for this iteration */
const elapsedMs = computed(() => {
  if (!props.steps.length) return 0
  const first = props.steps[0].timestamp
  const last = props.steps[props.steps.length - 1].timestamp
  return last - first
})

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function prettifyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/** Streaming content from this iteration */
const streamingText = computed(() => {
  for (const step of [...props.steps].reverse()) {
    if (step.streamingChoosing && !step.toolCalls?.length) {
      return { label: 'Choosing tools…', text: step.streamingChoosing }
    }
  }
  return null
})

const hasDisplayableActivity = computed(() =>
  isTaskContext.value ||
  toolCallArgs.value.length > 0 ||
  results.value.length > 0 ||
  Boolean(streamingText.value && props.isActive)
)

/** MA context */
const maContext = computed(() => {
  for (const step of props.steps) {
    if (step.maCodename) return { codename: step.maCodename, agentName: step.maAgentName }
    if (step.maPhase) return { phase: step.maPhase }
  }
  return null
})
</script>

<template>
  <div
    v-if="hasDisplayableActivity"
    class="px-4 py-1.5"
  >
    <div class="max-w-[80%] ml-3 md:ml-12">
      <CollapsibleSection v-model="expanded">
        <template #trigger="{ expanded: isExpanded, toggle, triggerAttrs }">
          <!-- Compact header — always visible -->
          <button
            v-bind="triggerAttrs"
            class="w-full flex items-center gap-2 px-3 py-2 rounded-2xl text-[13px] font-medium transition-all group shadow-sm"
            :class="[
              isTaskContext
                ? isExpanded
                  ? 'bg-cyan-100/60 border border-cyan-400/40 shadow-md shadow-cyan-500/5 dark:bg-cyan-950/20 dark:border-cyan-500/30 dark:shadow-cyan-950/10'
                  : 'bg-cyan-50/80 hover:bg-cyan-100/60 hover:border-cyan-400/35 border border-cyan-300/30 dark:bg-cyan-950/10 dark:hover:bg-cyan-950/20 dark:hover:border-cyan-500/25 dark:border-cyan-500/15'
                : isSubAgentSpawnIteration
                  ? isExpanded
                    ? 'bg-indigo-100/60 border border-indigo-400/40 shadow-md shadow-indigo-500/5 dark:bg-indigo-950/20 dark:border-indigo-500/35 dark:shadow-indigo-950/20'
                    : 'bg-indigo-50/80 hover:bg-indigo-100/60 hover:border-indigo-400/35 border border-indigo-300/30 dark:bg-indigo-950/10 dark:hover:bg-indigo-950/20 dark:hover:border-indigo-500/35 dark:border-indigo-500/20'
                  : isExpanded
                    ? 'bg-theme-800 border border-theme-700/60 shadow-md'
                    : 'bg-theme-800/60 hover:bg-theme-800 hover:border-theme-700/50 border border-transparent',
            ]"
            @click="toggle"
          >
            <!-- Status icon -->
            <Icon
              :icon="currentPhase.label === 'Denied' ? 'lucide:shield-x' : isRoutingStatus ? currentPhase.icon : toolNames.length && !results.length ? (isActive ? 'svg-spinners:ring-resize' : 'lucide:circle-slash') : allSuccess ? 'lucide:check-circle' : anyFailed ? 'lucide:alert-circle' : currentPhase.icon"
              class="w-3.5 h-3.5 shrink-0"
              :class="[
                currentPhase.label === 'Denied' ? 'text-red-500 dark:text-red-400' :
                isTaskContext ? 'text-cyan-600 dark:text-cyan-300' :
                isRoutingStatus ? 'text-accent-500 dark:text-accent-300' :
                toolNames.length && !results.length ? (isActive ? 'text-accent-500 dark:text-accent-400' : 'text-theme-500') :
                allSuccess ? 'text-emerald-500 dark:text-emerald-400' :
                anyFailed ? 'text-red-500 dark:text-red-400' :
                currentPhase.color
              ]"
            />

            <!-- MA context label -->
            <span
              v-if="maContext?.codename"
              class="text-[10px] text-indigo-500/80 dark:text-indigo-400/80 truncate max-w-16"
              :title="maContext.agentName || maContext.codename"
            >{{ maContext.codename }}</span>
            <span
              v-else-if="maContext?.phase"
              class="text-[10px] text-violet-400/80"
            >{{ maContext.phase }}</span>

            <!-- Tool / skill names -->
            <div class="flex items-center gap-1 flex-1 min-w-0 overflow-hidden">
              <template v-if="isTaskContext">
                <span class="text-cyan-600 dark:text-cyan-300 shrink-0">{{ headerLabel }}</span>
                <template v-if="taskContextQueryLabels.length">
                  <span
                    v-for="label in taskContextQueryLabels.slice(0, 3)"
                    :key="label"
                    class="inline-flex items-center gap-1 rounded-md bg-cyan-100/60 px-1.5 py-0.5 text-[10px] font-medium text-cyan-700 truncate max-w-35 dark:bg-cyan-500/10 dark:text-cyan-200"
                  >
                    {{ label }}
                  </span>
                  <span
                    v-if="taskContextQueryLabels.length > 3"
                    class="text-[10px] text-theme-500"
                  >+{{ taskContextQueryLabels.length - 3 }}</span>
                </template>
              </template>
              <template v-else-if="toolNames.length">
                <span
                  v-if="isRoutingStatus"
                  class="text-theme-400 shrink-0"
                  :class="currentPhase.color"
                >{{ headerLabel }}</span>
                <span
                  v-for="name in toolNames.slice(0, 3)"
                  :key="name"
                  class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium truncate max-w-35"
                  :class="toolChipClass(name)"
                >
                  <Icon
                    v-if="isSubAgentSpawnCall(name)"
                    icon="lucide:bot"
                    class="w-3 h-3 shrink-0"
                  />
                  {{ toolDisplayName(name) }}
                </span>
                <span
                  v-if="toolNames.length > 3"
                  class="text-[10px] text-theme-500"
                >+{{ toolNames.length - 3 }}</span>
              </template>
              <span
                v-else
                class="text-theme-400"
                :class="currentPhase.color"
              >{{ headerLabel }}</span>
            </div>

            <!-- Result count / status -->
            <span
              v-if="results.length"
              class="text-[10px] shrink-0"
              :class="allSuccess ? 'text-emerald-500/70 dark:text-emerald-400/70' : 'text-red-500/70 dark:text-red-400/70'"
            >{{ results.filter(r => r.success).length }}/{{ results.length }} ok</span>

            <!-- Elapsed -->
            <span
              v-if="elapsedMs > 0"
              class="text-[10px] text-theme-600 tabular-nums shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
            >{{ formatElapsed(elapsedMs) }}</span>

            <!-- Expand icon -->
            <Icon
              icon="lucide:chevron-down"
              class="w-3 h-3 text-theme-600 shrink-0 transition-transform"
              :class="{ 'rotate-180': isExpanded }"
            />
          </button>
        </template>

        <!-- Streaming text (always visible when actively streaming) -->
        <div
          v-if="streamingText && isActive"
          class="mt-1.5 ml-3 px-3 py-2 rounded-lg bg-theme-800/50 border border-theme-700/30"
        >
          <span class="text-[10px] text-theme-500 font-medium block mb-0.5">{{ streamingText.label }}</span>
          <p class="text-[11px] text-theme-400 whitespace-pre-wrap">
            {{ streamingText.text }}<span class="inline-block w-1.5 h-3 bg-theme-400/60 animate-pulse ml-0.5 align-middle" />
          </p>
        </div>

        <!-- Expanded details -->
        <div class="mt-1.5 ml-3 space-y-2">
          <!-- Tool call arguments -->
          <div
            v-if="isTaskContext && taskContext"
            class="rounded-lg border border-cyan-300/30 bg-cyan-50/80 px-3 py-2 dark:border-cyan-500/15 dark:bg-cyan-500/5"
          >
            <div class="flex items-center gap-1.5 mb-1.5">
              <Icon
                icon="lucide:compass"
                class="w-3 h-3 text-cyan-600 dark:text-cyan-300"
              />
              <span class="text-[11px] font-medium text-cyan-700 dark:text-cyan-200">Preparing context</span>
            </div>
            <div
              v-if="taskContextQueries.length"
              class="grid gap-1.5"
            >
              <div
                v-for="query in taskContextQueries"
                :key="query.label"
                class="rounded-md bg-cyan-50/50 px-2 py-1.5 dark:bg-theme-950/35"
              >
                <div class="text-[10px] font-medium uppercase tracking-wide text-cyan-600/70 dark:text-cyan-300/70">
                  {{ query.label }}
                </div>
                <p class="mt-0.5 text-[11px] leading-relaxed text-theme-400 whitespace-pre-wrap wrap-break-word">
                  {{ query.value }}
                </p>
              </div>
            </div>
            <p
              v-else-if="taskContext.content"
              class="rounded-md bg-cyan-50/50 px-2 py-1.5 text-[11px] leading-relaxed text-theme-400 whitespace-pre-wrap dark:bg-theme-950/35"
            >
              {{ taskContext.content }}
            </p>
          </div>

          <!-- Tool executions -->
          <div
            v-if="contextSections.length && !isTaskContext"
            class="space-y-2"
          >
            <div
              v-for="(section, sectionIndex) in contextSections"
              :key="`${section.status}-${section.phase}-${sectionIndex}`"
              class="rounded-lg border px-2.5 py-2"
              :class="contextSectionClass(section)"
            >
              <div class="mb-1.5 flex items-center gap-1.5">
                <Icon
                  :icon="contextSectionIcon(section)"
                  class="h-3 w-3 text-accent-500 dark:text-accent-300"
                />
                <span class="text-[11px] font-semibold text-theme-300">{{ contextSectionTitle(section) }}</span>
              </div>
              <div
                class="space-y-1.5"
              >
                <div
                  v-for="(execution, i) in section.executions"
                  :key="i"
                  class="rounded-lg border px-3 py-2"
                  :class="toolExecutionCardClass(execution)"
                >
                  <div class="flex items-center gap-1.5 mb-1">
                    <Icon
                      :icon="execution.result ? (execution.result.success ? 'lucide:check' : 'lucide:x') : execution.call ? toolCallIcon(execution.call) : 'lucide:terminal'"
                      class="w-3 h-3"
                      :class="execution.result
                        ? execution.result.success ? 'text-emerald-500 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'
                        : execution.call ? toolCallIconClass(execution.call.name, execution.call.arguments) : 'text-theme-500'"
                    />
                    <span
                      class="text-[11px] font-medium"
                      :class="toolExecutionNameClass(execution)"
                    >{{ toolDisplayName(execution.call?.name || execution.result?.name || 'Tool') }}</span>
                    <span
                      v-if="execution.call && isMemoryCall(execution.call) && formatRerankerScore(execution.call)"
                      class="ml-auto inline-flex items-center gap-1 rounded-md bg-accent-100/70 px-1.5 py-0.5 text-[10px] font-medium text-accent-700 ring-1 ring-accent-300/50 dark:bg-accent-500/10 dark:text-accent-200 dark:ring-accent-500/20"
                      title="Reranker match score"
                    >
                      <Icon
                        icon="lucide:percent"
                        class="w-3 h-3"
                      />
                      {{ formatRerankerScore(execution.call) }}
                    </span>
                    <span
                      v-if="execution.call && formatToolRouterScore(execution.call)"
                      class="ml-auto inline-flex items-center gap-1 rounded-md bg-accent-100/70 px-1.5 py-0.5 text-[10px] font-medium text-accent-700 ring-1 ring-accent-300/50 dark:bg-accent-500/10 dark:text-accent-200 dark:ring-accent-500/20"
                      title="Tool match score"
                    >
                      <Icon
                        icon="lucide:percent"
                        class="w-3 h-3"
                      />
                      {{ formatToolRouterScore(execution.call) }}
                    </span>
                    <span
                      v-if="execution.call && subAgentCodenameFromArgs(execution.call.arguments)"
                      class="ml-1 inline-flex rounded bg-indigo-200/40 px-1.5 py-0.5 text-[10px] text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300"
                    >{{ subAgentCodenameFromArgs(execution.call.arguments) }}</span>
                  </div>
                  <pre
                    v-if="execution.call && isMemoryCall(execution.call) && memoryCallContent(execution.call)"
                    class="text-[11px] leading-relaxed text-theme-300 whitespace-pre-wrap rounded px-2 py-1.5 max-h-64 overflow-y-auto bg-theme-900/70 dark:bg-theme-950/50"
                  >{{ memoryCallContent(execution.call) }}</pre>
                  <pre
                    v-else-if="toolRouterCallContent(execution.call)"
                    class="text-[11px] leading-relaxed text-theme-300 whitespace-pre-wrap rounded px-2 py-1.5 max-h-64 overflow-y-auto bg-theme-900/70 dark:bg-theme-950/50"
                  >{{ toolRouterCallContent(execution.call) }}</pre>
                  <pre
                    v-if="execution.call && isMemoryCall(execution.call) && memoryCallMetadata(execution.call)"
                    class="mt-1.5 text-[10px] text-theme-500 whitespace-pre-wrap break-all bg-theme-900 rounded px-2 py-1.5 max-h-32 overflow-y-auto font-mono dark:bg-theme-950/50"
                  >{{ memoryCallMetadata(execution.call) }}</pre>
                  <pre
                    v-else-if="execution.call?.arguments && execution.call.arguments !== '{}' && !isToolRouterScoreCall(execution.call)"
                    class="text-[10px] text-theme-500 whitespace-pre-wrap break-all bg-theme-900 rounded px-2 py-1.5 max-h-32 overflow-y-auto font-mono dark:bg-theme-950/50"
                  >{{ prettifyJson(execution.call.arguments) }}</pre>
                </div>
              </div>
            </div>
          </div>

          <!-- Tool executions -->
          <div
            v-else-if="toolExecutions.length && !isTaskContext"
            class="space-y-1.5"
          >
            <div
              v-for="(execution, i) in toolExecutions"
              :key="i"
              class="rounded-lg border px-3 py-2"
              :class="toolExecutionCardClass(execution)"
            >
              <div class="flex items-center gap-1.5 mb-1">
                <Icon
                  :icon="execution.result ? (execution.result.success ? 'lucide:check' : 'lucide:x') : execution.call ? toolCallIcon(execution.call) : 'lucide:terminal'"
                  class="w-3 h-3"
                  :class="execution.result
                    ? execution.result.success ? 'text-emerald-500 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'
                    : execution.call ? toolCallIconClass(execution.call.name, execution.call.arguments) : 'text-theme-500'"
                />
                <span
                  class="text-[11px] font-medium"
                  :class="toolExecutionNameClass(execution)"
                >{{ toolDisplayName(execution.call?.name || execution.result?.name || 'Tool') }}</span>
                <span
                  v-if="execution.call && isMemoryCall(execution.call) && formatRerankerScore(execution.call)"
                  class="ml-auto inline-flex items-center gap-1 rounded-md bg-accent-100/70 px-1.5 py-0.5 text-[10px] font-medium text-accent-700 ring-1 ring-accent-300/50 dark:bg-accent-500/10 dark:text-accent-200 dark:ring-accent-500/20"
                  title="Reranker match score"
                >
                  <Icon
                    icon="lucide:percent"
                    class="w-3 h-3"
                  />
                  {{ formatRerankerScore(execution.call) }}
                </span>
                <span
                  v-if="execution.call && formatToolRouterScore(execution.call)"
                  class="ml-auto inline-flex items-center gap-1 rounded-md bg-accent-100/70 px-1.5 py-0.5 text-[10px] font-medium text-accent-700 ring-1 ring-accent-300/50 dark:bg-accent-500/10 dark:text-accent-200 dark:ring-accent-500/20"
                  title="Tool match score"
                >
                  <Icon
                    icon="lucide:percent"
                    class="w-3 h-3"
                  />
                  {{ formatToolRouterScore(execution.call) }}
                </span>
                <span
                  v-if="execution.call && subAgentCodenameFromArgs(execution.call.arguments)"
                  class="ml-1 inline-flex rounded bg-indigo-200/40 px-1.5 py-0.5 text-[10px] text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300"
                >{{ subAgentCodenameFromArgs(execution.call.arguments) }}</span>
              </div>
              <pre
                v-if="execution.call && isMemoryCall(execution.call) && memoryCallContent(execution.call)"
                class="text-[11px] leading-relaxed text-theme-300 whitespace-pre-wrap rounded px-2 py-1.5 max-h-64 overflow-y-auto bg-theme-900/70 dark:bg-theme-950/50"
              >{{ memoryCallContent(execution.call) }}</pre>
              <pre
                v-else-if="toolRouterCallContent(execution.call)"
                class="text-[11px] leading-relaxed text-theme-300 whitespace-pre-wrap rounded px-2 py-1.5 max-h-64 overflow-y-auto bg-theme-900/70 dark:bg-theme-950/50"
              >{{ toolRouterCallContent(execution.call) }}</pre>
              <pre
                v-if="execution.call && isMemoryCall(execution.call) && memoryCallMetadata(execution.call)"
                class="mt-1.5 text-[10px] text-theme-500 whitespace-pre-wrap break-all bg-theme-900 rounded px-2 py-1.5 max-h-32 overflow-y-auto font-mono dark:bg-theme-950/50"
              >{{ memoryCallMetadata(execution.call) }}</pre>
              <pre
                v-else-if="execution.call?.arguments && execution.call.arguments !== '{}' && !isToolRouterScoreCall(execution.call)"
                class="text-[10px] text-theme-500 whitespace-pre-wrap break-all bg-theme-900 rounded px-2 py-1.5 max-h-32 overflow-y-auto font-mono dark:bg-theme-950/50"
              >{{ prettifyJson(execution.call.arguments) }}</pre>
              <pre
                v-if="execution.result"
                class="text-[10px] whitespace-pre-wrap break-all rounded px-2 py-1.5 max-h-64 overflow-y-auto font-mono"
                :class="[
                  execution.call?.arguments && execution.call.arguments !== '{}' ? 'mt-1.5' : '',
                  execution.result.success
                    ? 'text-theme-400 bg-theme-900/50'
                    : 'text-red-700/80 bg-red-100/80 dark:text-red-300/80 dark:bg-red-950/30'
                ]"
              >{{ prettifyJson(execution.result.output) }}</pre>
              <FileArtifactLinks
                v-if="execution.result"
                :text="execution.result.output"
              />
              <div
                v-if="execution.result?.images?.length"
                class="flex gap-2 mt-2 flex-wrap"
              >
                <img
                  v-for="(img, ii) in execution.result.images"
                  :key="ii"
                  :src="img"
                  class="h-24 rounded-lg border border-theme-600 object-cover cursor-pointer hover:border-accent-500 transition-colors"
                  :title="`Click to enlarge - Image ${ii + 1} from ${execution.result.name}`"
                  @click.stop="lightboxSrc = img"
                >
              </div>
              <p
                v-if="execution.result?.error"
                class="mt-1 text-[10px] text-red-600 dark:text-red-400"
              >
                {{ execution.result.error }}
              </p>
            </div>
          </div>
        </div>
      </CollapsibleSection>
    </div>
  </div>

  <!-- Image lightbox -->
  <Teleport to="body">
    <div
      v-if="lightboxSrc"
      class="fixed inset-0 z-100 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      tabindex="0"
      @click.self="lightboxSrc = null"
      @keydown.escape="lightboxSrc = null"
    >
      <button
        class="absolute top-4 right-4 p-2 rounded-full bg-theme-800/80 text-theme-300 hover:text-white hover:bg-theme-700 transition-colors z-10"
        title="Close"
        @click="lightboxSrc = null"
      >
        <Icon
          icon="mdi:close"
          class="w-5 h-5"
        />
      </button>
      <img
        :src="lightboxSrc"
        class="max-w-[90vw] max-h-[90vh] rounded-xl shadow-2xl object-contain"
        @click.stop
      >
    </div>
  </Teleport>
</template>
