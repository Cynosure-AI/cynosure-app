<script setup lang="ts">
import { computed, ref } from 'vue'
import { Icon } from '@iconify/vue'
import { usePreferencesStore } from '../../stores/preferences.store'
import CollapsibleSection from '../shared/CollapsibleSection.vue'
import FileArtifactLinks from './FileArtifactLinks.vue'
import { isInternalToolName } from '../../utils/internal-tools'

export interface ToolExecStep {
  iteration: number
  status: string
  message?: string
  toolCalls?: ToolCall[]
  results?: ToolResult[]
  streamingChoosing?: string
  timestamp: number
  taskId?: string
  maCodename?: string
  maAgentName?: string
  maInvocationId?: string
  maPhase?: string
}

type ToolCall = { name: string; arguments: string }
type ToolResult = { name: string; success: boolean; output: string; error?: string; images?: string[] }
type StatusMeta = { label: string; icon: string; color: string }
type ContextSectionKind = 'tool' | 'memory'
type ContextRowState = 'selected' | 'candidate'
type ToolExecution = { call: ToolCall | null; result?: ToolResult }
type ContextRow = ToolExecution & { state: ContextRowState }
type ContextSection = {
  status: string
  phase: string
  kind: ContextSectionKind | null
  calls: ToolCall[]
  executions: ToolExecution[]
}
type MergedContextSection = ContextSection & { rows: ContextRow[] }
type ExecutionSection = {
  key: string
  title?: string
  icon?: string
  class?: string
  iconClass?: string
  rows: (ToolExecution | ContextRow)[]
  compactContext?: boolean
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

const FALLBACK_META: StatusMeta = { label: 'Executing', icon: 'lucide:play', color: 'text-emerald-500 dark:text-emerald-400' }
const STATUS_META: Record<string, StatusMeta> = {
  'building-task-context': { label: 'Preparing Context', icon: 'lucide:compass', color: 'text-cyan-600 dark:text-cyan-300' },
  'indexing-attachments': { label: 'Indexing Attachments', icon: 'lucide:paperclip', color: 'text-sky-600 dark:text-sky-300' },
  'routing-tools': { label: 'Gathering Tool Context', icon: 'lucide:route', color: 'text-accent-500 dark:text-accent-300' },
  'routing-memory': { label: 'Gathering Memory Context', icon: 'lucide:brain-circuit', color: 'text-accent-500 dark:text-accent-300' },
  'curating-tools': { label: 'Refining Tool Context', icon: 'lucide:list-filter', color: 'text-accent-500 dark:text-accent-300' },
  'curating-memory': { label: 'Refining Memory Context', icon: 'lucide:list-filter', color: 'text-accent-500 dark:text-accent-300' },
  'awaiting-approval': { label: 'Awaiting approval', icon: 'lucide:shield-question', color: 'text-amber-500 dark:text-amber-400' },
  denied: { label: 'Denied', icon: 'lucide:shield-x', color: 'text-red-500 dark:text-red-400' },
  executing: FALLBACK_META,
  'ma-status': { label: 'Orchestrator', icon: 'lucide:network', color: 'text-violet-500 dark:text-violet-400' },
  'ma-subagent-running': { label: 'Sub-agent running', icon: 'lucide:bot', color: 'text-indigo-500 dark:text-indigo-400' },
  'ma-subagent-done': { label: 'Sub-agent done', icon: 'lucide:check', color: 'text-emerald-500 dark:text-emerald-400' },
  'ma-subagent-failed': { label: 'Sub-agent failed', icon: 'lucide:x', color: 'text-red-500 dark:text-red-400' },
  'ma-done': { label: 'Complete', icon: 'lucide:check-circle-2', color: 'text-emerald-500 dark:text-emerald-400' },
  'ma-error': { label: 'Error', icon: 'lucide:alert-circle', color: 'text-red-500 dark:text-red-400' },
  'ma-file': { label: 'File', icon: 'lucide:file-text', color: 'text-theme-400' },
  'memory-retrieved': { label: 'Memory retrieved', icon: 'lucide:brain', color: 'text-accent-500 dark:text-accent-300' },
}

const argCache = new Map<string, Record<string, unknown> | null>()

function parseArgs(args = '{}'): Record<string, unknown> | null {
  if (argCache.has(args)) return argCache.get(args) ?? null

  try {
    const parsed = JSON.parse(args || '{}')
    const value = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
    argCache.set(args, value)
    return value
  } catch {
    argCache.set(args, null)
    return null
  }
}

function argType(call?: Pick<ToolCall, 'arguments'> | null): string {
  const type = call ? parseArgs(call.arguments)?.type : undefined
  return typeof type === 'string' ? type : ''
}

function meta(status?: string): StatusMeta {
  return status ? STATUS_META[status] ?? { label: status, icon: 'lucide:circle', color: 'text-theme-400' } : FALLBACK_META
}

function normalizeScore(score: unknown): string | null {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null
  const normalized = score > 1 ? score / 100 : score
  return `${Math.round(Math.max(0, Math.min(1, normalized)) * 100)}%`
}

function visibleText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isSubAgentSpawnCall(name?: string): boolean {
  return name === 'spawn_subagent'
}

function isMemoryCall(call?: Pick<ToolCall, 'arguments'> | null): boolean {
  return argType(call) === 'memory'
}

function isTaskContextCall(call?: Pick<ToolCall, 'arguments'> | null): boolean {
  const type = argType(call)
  return type === 'task-context' || type === 'auto-router'
}

function isAttachmentIndexCall(call?: Pick<ToolCall, 'arguments'> | null): boolean {
  return argType(call) === 'attachment-index'
}

function isToolRouterCall(call?: Pick<ToolCall, 'arguments'> | null): boolean {
  return argType(call) === 'tool-router'
}

function isContextGatheringCall(call: ToolCall): boolean {
  return isMemoryCall(call) || isToolRouterCall(call)
}

function isDisabledContextCall(call: ToolCall): boolean {
  return isContextGatheringCall(call) && parseArgs(call.arguments)?.emptyReason === 'disabled'
}

function contextPhase(call?: ToolCall | null): string {
  return visibleText(call ? parseArgs(call.arguments)?.contextPhase : undefined) ?? ''
}

function contextSectionKind(status: string): ContextSectionKind | null {
  if (status.endsWith('-tools')) return 'tool'
  if (status.endsWith('-memory')) return 'memory'
  return null
}

function toolDisplayName(name = 'Tool'): string {
  if (name === 'Task context') return 'Preparing Context'
  return isSubAgentSpawnCall(name) ? 'Spawn sub-agent' : name
}

function scoreForCall(call?: ToolCall | null): string | null {
  if (!call) return null
  const parsed = parseArgs(call.arguments)
  if (isMemoryCall(call)) return normalizeScore(parsed?.rerankerScore)
  if (isToolRouterCall(call)) return normalizeScore(parsed?.routerScore)
  return null
}

function callContent(call?: ToolCall | null): string | null {
  if (!call || (!isMemoryCall(call) && !isToolRouterCall(call))) return null
  return visibleText(parseArgs(call.arguments)?.content)
}

function memoryCallMetadata(call: ToolCall): string {
  const parsed = parseArgs(call.arguments)
  if (!parsed) return call.arguments

  const { content: _content, contextPhase: _contextPhase, ...metadata } = parsed
  return Object.keys(metadata).length ? JSON.stringify(metadata, null, 2) : ''
}

function subAgentCodenameFromArgs(args: string): string | null {
  return visibleText(parseArgs(args)?.codename)
}

function prettifyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

function formatElapsed(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function visibleToolCalls(calls: ToolCall[] = []): ToolCall[] {
  return calls.filter((call) => {
    if (isDisabledContextCall(call)) return false
    return prefs.showInternalToolCalls || isTaskContextCall(call) || !isInternalToolName(call.name)
  })
}

function isInternalExecution(execution: ToolExecution): boolean {
  return isInternalToolName(execution.call?.name || execution.result?.name)
}

function isCandidateRow(execution: ToolExecution | ContextRow): execution is ContextRow {
  return 'state' in execution && execution.state === 'candidate'
}

function buildExecutions(calls: ToolCall[], availableResults: ToolResult[] = []): ToolExecution[] {
  const remainingResults = [...availableResults]
  const executions = calls.map((call, index) => {
    let resultIndex = remainingResults.findIndex((result) => result.name === call.name)
    if (resultIndex === -1 && remainingResults[index]) resultIndex = index

    return {
      call,
      result: resultIndex === -1 ? undefined : remainingResults.splice(resultIndex, 1)[0],
    }
  })

  return [...executions, ...remainingResults.map((result) => ({ call: null, result }))]
}

function contextCallKey(call: ToolCall): string {
  const parsed = parseArgs(call.arguments)
  if (parsed?.type === 'memory') {
    return ['memory', call.name, parsed.sourceFile, parsed.folderPath, parsed.chunkIndex, parsed.content]
      .map((value) => String(value ?? ''))
      .join('|')
  }

  return `${String(parsed?.type ?? '')}|${call.name}`
}

function mergeContextSections(sections: ContextSection[]): MergedContextSection[] {
  const merged: MergedContextSection[] = []
  const consumed = new Set<number>()

  sections.forEach((section, index) => {
    if (consumed.has(index)) return

    const finalIndex = sections.findIndex((candidate, candidateIndex) =>
      candidateIndex > index &&
      !consumed.has(candidateIndex) &&
      candidate.kind === section.kind &&
      candidate.phase === 'gathered-context',
    )

    if (section.phase === 'gathered-results' && finalIndex !== -1) {
      const finalSection = sections[finalIndex]
      const selectedKeys = new Set(finalSection.calls.map(contextCallKey))
      const selectedRows = finalSection.executions.map((execution) => ({ ...execution, state: 'selected' as const }))
      const candidateRows = section.executions
        .filter((execution) => execution.call && !selectedKeys.has(contextCallKey(execution.call)))
        .map((execution) => ({ ...execution, state: 'candidate' as const }))

      merged.push({ ...finalSection, rows: [...selectedRows, ...candidateRows] })
      consumed.add(index)
      consumed.add(finalIndex)
      return
    }

    merged.push({
      ...section,
      rows: section.executions.map((execution) => ({
        ...execution,
        state: section.phase === 'gathered-results' ? 'candidate' : 'selected',
      })),
    })
    consumed.add(index)
  })

  return merged
}

function contextSectionTitle(section: Pick<ContextSection, 'status' | 'phase' | 'kind'>): string {
  const prefix = section.kind === 'tool' ? 'Tool' : section.kind === 'memory' ? 'Memory' : ''

  if (section.phase === 'gathered-results' || section.status === 'routing-tools' || section.status === 'routing-memory') {
    return prefix ? `Gathered ${prefix} Results` : 'Gathered Results'
  }

  if (section.phase === 'gathered-context' || section.status === 'curating-tools' || section.status === 'curating-memory') {
    return prefix ? `Gathered ${prefix} Context` : 'Gathered Context'
  }

  return meta(section.status).label
}

function isCuratedContext(section: Pick<ContextSection, 'status' | 'phase'>): boolean {
  return section.phase === 'gathered-context' || section.status === 'curating-tools' || section.status === 'curating-memory'
}

function contextSectionIcon(section: ContextSection): string {
  if (isCuratedContext(section)) return section.kind === 'memory' ? 'lucide:brain' : 'lucide:package-check'
  return section.kind === 'memory' ? 'lucide:brain-circuit' : 'lucide:database'
}

function contextSectionClass(section: ContextSection): string {
  return isCuratedContext(section)
    ? 'border-teal-400/30 bg-teal-500/5 dark:border-teal-500/25 dark:bg-teal-500/5'
    : 'border-sky-400/25 bg-sky-500/5 dark:border-sky-500/20 dark:bg-sky-500/5'
}

function contextSectionIconClass(section: ContextSection): string {
  return isCuratedContext(section) ? 'text-teal-600 dark:text-teal-300' : 'text-sky-600 dark:text-sky-300'
}

function toolChipClass(name: string): string {
  if (isInternalToolName(name)) return 'bg-purple-500/10 text-purple-600 ring-1 ring-purple-400/25 dark:text-purple-300 dark:ring-purple-500/20'
  if (name === 'Task context') return 'bg-cyan-200/40 text-cyan-700 ring-1 ring-cyan-400/25 dark:bg-cyan-500/10 dark:text-cyan-300 dark:ring-cyan-500/15'
  return isSubAgentSpawnCall(name)
    ? 'bg-indigo-200/40 text-indigo-700 ring-1 ring-indigo-400/30 dark:bg-indigo-500/15 dark:text-indigo-300 dark:ring-indigo-500/20'
    : 'bg-accent-200/40 text-accent-700 dark:bg-accent-500/10 dark:text-accent-300'
}

function toolCallIcon(call?: ToolCall | null): string {
  if (!call) return 'lucide:terminal'
  if (isAttachmentIndexCall(call)) return 'lucide:paperclip'
  if (isTaskContextCall(call)) return 'lucide:compass'
  if (isSubAgentSpawnCall(call.name)) return 'lucide:bot'
  if (isMemoryCall(call)) return 'lucide:brain'
  return 'lucide:terminal'
}

function toolCallIconClass(call?: ToolCall | null): string {
  if (!call) return 'text-theme-500'
  if (isAttachmentIndexCall(call)) return 'text-sky-600 dark:text-sky-300'
  if (isTaskContextCall(call)) return 'text-cyan-600 dark:text-cyan-300'
  if (isInternalToolName(call.name)) return 'text-purple-500 dark:text-purple-300'
  return isSubAgentSpawnCall(call.name) ? 'text-indigo-500 dark:text-indigo-400' : 'text-accent-500 dark:text-accent-400'
}

function executionIcon(execution: ToolExecution): string {
  if (!execution.result) return toolCallIcon(execution.call)
  return execution.result.success ? 'lucide:check' : 'lucide:x'
}

function executionIconClass(execution: ToolExecution): string {
  if (!execution.result) return toolCallIconClass(execution.call)
  return execution.result.success ? 'text-emerald-500 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'
}

function executionCardClass(execution: ToolExecution | ContextRow): string {
  if (isCandidateRow(execution)) return 'bg-theme-900/45 border-theme-700/35 opacity-70'
  if (isInternalExecution(execution)) {
    return execution.result?.success === false
      ? 'bg-red-50/80 border-red-300/30 dark:bg-red-500/5 dark:border-red-500/15'
      : 'bg-purple-50/80 border-purple-300/30 dark:bg-purple-500/5 dark:border-purple-500/20'
  }
  if (isSubAgentSpawnCall(execution.call?.name)) return 'bg-indigo-500/10 border-indigo-500/20 dark:bg-indigo-950/15 dark:border-indigo-500/25'
  if (execution.result?.success === false) return 'bg-red-50/80 border-red-300/30 dark:bg-red-500/5 dark:border-red-500/15'
  return execution.result
    ? 'bg-emerald-50/80 border-emerald-300/30 dark:bg-emerald-500/5 dark:border-emerald-500/15'
    : 'bg-theme-950 border-theme-700 dark:bg-theme-900/60 dark:border-theme-700/30'
}

function executionNameClass(execution: ToolExecution | ContextRow): string {
  if (isCandidateRow(execution)) return 'text-theme-500 line-through decoration-theme-500/70'
  if (execution.result?.success === false) return 'text-red-600 dark:text-red-300'
  if (isInternalExecution(execution)) return 'text-purple-600 dark:text-purple-300'
  return isSubAgentSpawnCall(execution.call?.name)
    ? 'text-indigo-600 dark:text-indigo-300'
    : 'text-accent-500 dark:text-accent-300'
}

function scoreBadgeClass(execution: ToolExecution | ContextRow): string {
  return isCandidateRow(execution)
    ? 'bg-theme-800/70 text-theme-500 ring-theme-700/60 dark:bg-theme-800/50 dark:text-theme-500 dark:ring-theme-700/50'
    : 'bg-accent-100/70 text-accent-700 ring-accent-300/50 dark:bg-accent-500/10 dark:text-accent-200 dark:ring-accent-500/20'
}

function headerButtonClass(isExpanded: boolean): string {
  if (isTaskContext.value) {
    return isExpanded
      ? 'bg-cyan-100/60 border border-cyan-400/40 shadow-md shadow-cyan-500/5 dark:bg-cyan-950/20 dark:border-cyan-500/30 dark:shadow-cyan-950/10'
      : 'bg-cyan-50/80 hover:bg-cyan-100/60 hover:border-cyan-400/35 border border-cyan-300/30 dark:bg-cyan-950/10 dark:hover:bg-cyan-950/20 dark:hover:border-cyan-500/25 dark:border-cyan-500/15'
  }

  if (isSubAgentSpawnIteration.value) {
    return isExpanded
      ? 'bg-indigo-100/60 border border-indigo-400/40 shadow-md shadow-indigo-500/5 dark:bg-indigo-950/20 dark:border-indigo-500/35 dark:shadow-indigo-950/20'
      : 'bg-indigo-50/80 hover:bg-indigo-100/60 hover:border-indigo-400/35 border border-indigo-300/30 dark:bg-indigo-950/10 dark:hover:bg-indigo-950/20 dark:hover:border-indigo-500/35 dark:border-indigo-500/20'
  }

  return isExpanded
    ? 'bg-theme-800 border border-theme-700/60 shadow-md'
    : 'bg-theme-800/60 hover:bg-theme-800 hover:border-theme-700/50 border border-transparent'
}

const latestStep = computed(() => props.steps.at(-1))
const currentStatus = computed(() => latestStep.value?.status ?? 'executing')
const currentPhase = computed(() => meta(currentStatus.value))

const latestToolCalls = computed(() => [...props.steps].reverse().find((step) => step.toolCalls?.length)?.toolCalls ?? [])
const rawToolCallArgs = computed(() => latestToolCalls.value)
const toolCallArgs = computed(() => visibleToolCalls(rawToolCallArgs.value))

const results = computed(() => {
  const latestResults = [...props.steps].reverse().find((step) => step.results?.length)?.results ?? []
  return prefs.showInternalToolCalls
    ? latestResults
    : latestResults.filter((result) => !isInternalToolName(result.name))
})

const toolNames = computed(() => visibleToolCalls(latestToolCalls.value).map((call) => call.name))
const isSubAgentSpawnIteration = computed(() => toolNames.value.some(isSubAgentSpawnCall))

const isTaskContext = computed(() => props.steps.some((step) => step.status === 'building-task-context' || step.toolCalls?.some(isTaskContextCall)))
const isAttachmentIndexing = computed(() => props.steps.some((step) => step.status === 'indexing-attachments' || step.toolCalls?.some(isAttachmentIndexCall)))
const isToolRouting = computed(() => currentStatus.value === 'routing-tools' || currentStatus.value === 'curating-tools')
const isMemoryRouting = computed(() => currentStatus.value === 'routing-memory' || currentStatus.value === 'curating-memory')
const isRoutingStatus = computed(() => isTaskContext.value || isAttachmentIndexing.value || isToolRouting.value || isMemoryRouting.value)

const allSuccess = computed(() => results.value.length > 0 && results.value.every((result) => result.success))
const anyFailed = computed(() => results.value.some((result) => !result.success))
const successfulResultCount = computed(() => results.value.filter((result) => result.success).length)

const elapsedMs = computed(() => {
  if (!props.steps.length) return 0
  return props.steps.at(-1)!.timestamp - props.steps[0].timestamp
})

const streamingText = computed(() => {
  const step = [...props.steps].reverse().find((candidate) => candidate.streamingChoosing && !candidate.toolCalls?.length)
  return step?.streamingChoosing ? { label: 'Choosing tools…', text: step.streamingChoosing } : null
})

const maContext = computed(() => {
  for (const step of props.steps) {
    if (step.maCodename) return { codename: step.maCodename, agentName: step.maAgentName }
    if (step.maPhase) return { phase: step.maPhase }
  }
  return null
})

const taskContext = computed(() => {
  const parsed = parseArgs(rawToolCallArgs.value.find(isTaskContextCall)?.arguments)
  if (!parsed) return null

  return {
    toolQuery: visibleText(parsed.toolQuery) ?? '',
    memoryQuery: visibleText(parsed.memoryQuery) ?? '',
    content: visibleText(parsed.content) ?? '',
    emptyReason: visibleText(parsed.emptyReason) ?? '',
  }
})

const taskContextQueries = computed(() => [
  { label: 'Tools', value: taskContext.value?.toolQuery ?? '' },
  { label: 'Memory', value: taskContext.value?.memoryQuery ?? '' },
].filter((query) => query.value))

const taskContextQueryLabels = computed(() => taskContextQueries.value.map((query) => query.label))

const contextSections = computed<ContextSection[]>(() => props.steps
  .filter((step) => step.toolCalls?.length && !step.toolCalls.some(isTaskContextCall))
  .map((step) => {
    const calls = visibleToolCalls(step.toolCalls)
    return {
      status: step.status,
      phase: contextPhase(calls[0]),
      kind: contextSectionKind(step.status),
      calls,
      executions: buildExecutions(calls),
    }
  })
  .filter((section) => section.calls.some(isContextGatheringCall)))

const mergedContextSections = computed(() => mergeContextSections(contextSections.value))
const toolExecutions = computed(() => buildExecutions(toolCallArgs.value, results.value))

const executionSections = computed<ExecutionSection[]>(() => {
  if (isTaskContext.value) return []

  if (mergedContextSections.value.length) {
    return mergedContextSections.value.map((section, index) => ({
      key: `${section.status}-${section.phase}-${index}`,
      title: contextSectionTitle(section),
      icon: contextSectionIcon(section),
      class: contextSectionClass(section),
      iconClass: contextSectionIconClass(section),
      rows: section.rows,
      compactContext: true,
    }))
  }

  if (!toolExecutions.value.length) return []
  return [{ key: 'tool-executions', rows: toolExecutions.value }]
})

const headerLabel = computed(() => {
  if (isTaskContext.value || isAttachmentIndexing.value) return currentPhase.value.label

  const latestContextSection = [...mergedContextSections.value].reverse()[0]
  if (latestContextSection?.phase === 'gathered-context') return contextSectionTitle(latestContextSection)

  return currentPhase.value.label
})

const headerIcon = computed(() => {
  if (currentPhase.value.label === 'Denied') return 'lucide:shield-x'
  if (isRoutingStatus.value) return currentPhase.value.icon
  if (toolNames.value.length && !results.value.length) return props.isActive ? 'svg-spinners:ring-resize' : 'lucide:circle-slash'
  if (allSuccess.value) return 'lucide:check-circle'
  if (anyFailed.value) return 'lucide:alert-circle'
  return currentPhase.value.icon
})

const headerIconClass = computed(() => {
  if (currentPhase.value.label === 'Denied') return 'text-red-500 dark:text-red-400'
  if (isTaskContext.value) return 'text-cyan-600 dark:text-cyan-300'
  if (isRoutingStatus.value) return 'text-accent-500 dark:text-accent-300'
  if (toolNames.value.length && !results.value.length) return props.isActive ? 'text-accent-500 dark:text-accent-400' : 'text-theme-500'
  if (allSuccess.value) return 'text-emerald-500 dark:text-emerald-400'
  if (anyFailed.value) return 'text-red-500 dark:text-red-400'
  return currentPhase.value.color
})

const hasDisplayableActivity = computed(() =>
  isTaskContext.value ||
  toolCallArgs.value.length > 0 ||
  results.value.length > 0 ||
  Boolean(streamingText.value && props.isActive),
)
</script>

<template>
  <div
    v-if="hasDisplayableActivity"
    class="px-4 py-1.5"
  >
    <div class="max-w-[80%] ml-3 md:ml-12">
      <CollapsibleSection v-model="expanded">
        <template #trigger="{ expanded: isExpanded, toggle, triggerAttrs }">
          <button
            v-bind="triggerAttrs"
            class="w-full flex items-center gap-2 px-3 py-2 rounded-2xl text-[13px] font-medium transition-all group shadow-sm"
            :class="headerButtonClass(isExpanded)"
            @click="toggle"
          >
            <Icon
              :icon="headerIcon"
              class="w-3.5 h-3.5 shrink-0"
              :class="headerIconClass"
            />

            <span
              v-if="maContext?.codename"
              class="text-[10px] text-indigo-500/80 dark:text-indigo-400/80 truncate max-w-16"
              :title="maContext.agentName || maContext.codename"
            >{{ maContext.codename }}</span>
            <span
              v-else-if="maContext?.phase"
              class="text-[10px] text-violet-400/80"
            >{{ maContext.phase }}</span>

            <div class="flex items-center gap-1 flex-1 min-w-0 overflow-hidden">
              <template v-if="isTaskContext">
                <span class="text-cyan-600 dark:text-cyan-300 shrink-0">{{ headerLabel }}</span>
                <span
                  v-for="label in taskContextQueryLabels.slice(0, 3)"
                  :key="label"
                  class="inline-flex items-center gap-1 rounded-md bg-cyan-100/60 px-1.5 py-0.5 text-[10px] font-medium text-cyan-700 truncate max-w-35 dark:bg-cyan-500/10 dark:text-cyan-200"
                >{{ label }}</span>
                <span
                  v-if="taskContextQueryLabels.length > 3"
                  class="text-[10px] text-theme-500"
                >+{{ taskContextQueryLabels.length - 3 }}</span>
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

            <span
              v-if="results.length"
              class="text-[10px] shrink-0"
              :class="allSuccess ? 'text-emerald-500/70 dark:text-emerald-400/70' : 'text-red-500/70 dark:text-red-400/70'"
            >{{ successfulResultCount }}/{{ results.length }} ok</span>

            <span
              v-if="elapsedMs > 0"
              class="text-[10px] text-theme-600 tabular-nums shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
            >{{ formatElapsed(elapsedMs) }}</span>

            <Icon
              icon="lucide:chevron-down"
              class="w-3 h-3 text-theme-600 shrink-0 transition-transform"
              :class="{ 'rotate-180': isExpanded }"
            />
          </button>
        </template>

        <div
          v-if="streamingText && isActive"
          class="mt-1.5 ml-3 px-3 py-2 rounded-lg bg-theme-800/50 border border-theme-700/30"
        >
          <span class="text-[10px] text-theme-500 font-medium block mb-0.5">{{ streamingText.label }}</span>
          <p class="text-[11px] text-theme-400 whitespace-pre-wrap">
            {{ streamingText.text }}<span class="inline-block w-1.5 h-3 bg-theme-400/60 animate-pulse ml-0.5 align-middle" />
          </p>
        </div>

        <div class="mt-1.5 ml-3 space-y-2">
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

          <div
            v-for="section in executionSections"
            :key="section.key"
            :class="section.compactContext ? ['rounded-lg border px-2.5 py-2', section.class] : 'space-y-1.5'"
          >
            <div
              v-if="section.compactContext"
              class="mb-1.5 flex items-center gap-1.5"
            >
              <Icon
                :icon="section.icon || 'lucide:terminal'"
                class="h-3 w-3"
                :class="section.iconClass"
              />
              <span class="text-[11px] font-semibold text-theme-300">{{ section.title }}</span>
            </div>

            <div :class="section.compactContext ? 'space-y-1.5' : 'space-y-1.5'">
              <div
                v-for="(execution, i) in section.rows"
                :key="i"
                class="rounded-lg border px-3 py-2"
                :class="executionCardClass(execution)"
              >
                <div class="flex items-center gap-1.5 mb-1">
                  <Icon
                    :icon="executionIcon(execution)"
                    class="w-3 h-3"
                    :class="executionIconClass(execution)"
                  />
                  <span
                    class="text-[11px] font-medium"
                    :class="executionNameClass(execution)"
                  >{{ toolDisplayName(execution.call?.name || execution.result?.name) }}</span>

                  <span
                    v-if="execution.call && scoreForCall(execution.call)"
                    class="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1"
                    :class="scoreBadgeClass(execution)"
                    :title="isMemoryCall(execution.call) ? 'Reranker match score' : 'Tool match score'"
                  >
                    <Icon
                      icon="lucide:percent"
                      class="w-3 h-3"
                    />
                    {{ scoreForCall(execution.call) }}
                  </span>

                  <span
                    v-if="execution.call && subAgentCodenameFromArgs(execution.call.arguments)"
                    class="ml-1 inline-flex rounded bg-indigo-200/40 px-1.5 py-0.5 text-[10px] text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300"
                  >{{ subAgentCodenameFromArgs(execution.call.arguments) }}</span>
                </div>

                <pre
                  v-if="callContent(execution.call)"
                  class="text-[11px] leading-relaxed text-theme-300 whitespace-pre-wrap rounded px-2 py-1.5 max-h-64 overflow-y-auto bg-theme-900/70 dark:bg-theme-950/50"
                >{{ callContent(execution.call) }}</pre>

                <template v-if="!section.compactContext">
                  <pre
                    v-if="execution.call && isMemoryCall(execution.call) && memoryCallMetadata(execution.call)"
                    class="mt-1.5 text-[10px] text-theme-500 whitespace-pre-wrap break-all bg-theme-900 rounded px-2 py-1.5 max-h-32 overflow-y-auto font-mono dark:bg-theme-950/50"
                  >{{ memoryCallMetadata(execution.call) }}</pre>
                  <pre
                    v-else-if="execution.call?.arguments && execution.call.arguments !== '{}' && !scoreForCall(execution.call)"
                    class="text-[10px] text-theme-500 whitespace-pre-wrap break-all bg-theme-900 rounded px-2 py-1.5 max-h-32 overflow-y-auto font-mono dark:bg-theme-950/50"
                  >{{ prettifyJson(execution.call.arguments) }}</pre>

                  <pre
                    v-if="execution.result"
                    class="text-[10px] whitespace-pre-wrap break-all rounded px-2 py-1.5 max-h-64 overflow-y-auto font-mono"
                    :class="[
                      execution.call?.arguments && execution.call.arguments !== '{}' ? 'mt-1.5' : '',
                      execution.result.success
                        ? 'text-theme-400 bg-theme-900/50'
                        : 'text-red-700/80 bg-red-100/80 dark:text-red-300/80 dark:bg-red-950/30',
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
                      v-for="(img, imageIndex) in execution.result.images"
                      :key="imageIndex"
                      :src="img"
                      class="h-24 rounded-lg border border-theme-600 object-cover cursor-pointer hover:border-accent-500 transition-colors"
                      :title="`Click to enlarge - Image ${imageIndex + 1} from ${execution.result.name}`"
                      @click.stop="lightboxSrc = img"
                    >
                  </div>

                  <p
                    v-if="execution.result?.error"
                    class="mt-1 text-[10px] text-red-600 dark:text-red-400"
                  >
                    {{ execution.result.error }}
                  </p>
                </template>
              </div>
            </div>
          </div>
        </div>
      </CollapsibleSection>
    </div>
  </div>

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
