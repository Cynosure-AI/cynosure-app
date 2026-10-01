<script setup lang="ts">
import { computed, ref } from 'vue'
import { Icon } from '@iconify/vue'
import CollapsibleSection from '../shared/CollapsibleSection.vue'
import ArtifactImageModal from '../shared/ArtifactImageModal.vue'
import FileArtifactLinks from './FileArtifactLinks.vue'
import ToolExecutionList from './ToolExecutionList.vue'
import ToolNamespaceIcon from './ToolNamespaceIcon.vue'
import { fileArtifactKey, fileArtifactLinks } from '../../utils/file-artifacts'
import { isBuiltInNamespaceId, isInternalToolName } from '../../utils/internal-tools'
import RichContent from '../shared/RichContent.vue'
import { useAgentStore } from '../../stores/agent-runtime.store'
import { useMcpServers } from '../../composables/useMcpServers'
import { getToolNamespaceIcon } from '../../utils/tool-namespace-icons'

export interface ToolExecStep {
  iteration: number
  status: string
  message?: string
  toolCalls?: ToolCall[]
  results?: ToolResult[]
  streamingChoosing?: string
  timestamp: number
  updatedAt?: number
  taskId?: string
  maCodename?: string
  maAgentName?: string
  maInvocationId?: string
  maPhase?: string
}

type ToolCall = { name: string; arguments: string }
type ToolResult = { name: string; success: boolean; output: string; error?: string; images?: string[] }
type StatusMeta = { label: string; icon: string; color: string }
type ResultOutcomeMeta = { label: string; icon: string; color: string }
type ContextSectionKind = 'tool' | 'memory' | 'entity'
type ContextRowState = 'selected' | 'candidate'
type ToolExecution = { call: ToolCall | null; result?: ToolResult }
type ContextRow = ToolExecution & { state: ContextRowState }
type ContextSection = {
  status: string
  phase: string
  kind: ContextSectionKind | null
  timestamp: number
  calls: ToolCall[]
  executions: ToolExecution[]
}
type MergedContextSection = ContextSection & { rows: ContextRow[] }
type ContextExecutionSection = {
  key: string
  title: string
  icon: string
  class: string
  iconClass: string
  rows: ContextRow[]
  isLoading: boolean
  timestamp: number
  tone: 'cyan' | 'green' | 'violet'
}

const props = defineProps<{
  /** Iteration number (1-based) */
  iteration: number
  /** Execution steps for this iteration */
  steps: ToolExecStep[]
  /** Whether this iteration is actively executing */
  isActive: boolean
  /** The delegation's outcome is rendered later in the timeline. */
  delegationHandoff?: boolean
}>()

const agentStore = useAgentStore()
const { servers } = useMcpServers()
const toolsByName = computed(() => {
  const tools = new Map(agentStore.availableTools.map((tool) => [tool.executionName, tool]))
  for (const tool of agentStore.availableTools) {
    tools.set(tool.key, tool)
    if (!tool.ambiguous && !tools.has(tool.name)) tools.set(tool.name, tool)
  }
  return tools
})

function isBuiltInTool(name = ''): boolean {
  const tool = toolsByName.value.get(name)
  return tool ? isBuiltInNamespaceId(tool.namespace.id) : isInternalToolName(name)
}

function toolNamespaceIcon(name = ''): string {
  const namespaceId = toolsByName.value.get(name)?.namespace.id
  return namespaceId ? getToolNamespaceIcon(namespaceId) : toolCallIcon({ name, arguments: '{}' })
}

function toolIconUrl(name = ''): string | undefined {
  const namespaceId = toolsByName.value.get(name)?.namespace.id
  if (!namespaceId?.startsWith('mcp:')) return undefined
  return servers.value.find((server) => server.id === namespaceId.slice(4))?.icon_url || undefined
}

// Context preparation details are collapsed independently of tool execution rows.
const expanded = ref(false)
const lightboxSrc = ref<string | null>(null)

const FALLBACK_META: StatusMeta = { label: 'Executing', icon: 'lucide:play', color: 'text-status-success' }
const STATUS_META: Record<string, StatusMeta> = {
  'building-task-context': { label: 'Preparing Context', icon: 'lucide:compass', color: 'text-cyan-600 dark:text-cyan-300' },
  'indexing-attachments': { label: 'Indexing Attachments', icon: 'lucide:paperclip', color: 'text-sky-600 dark:text-sky-300' },
  'indexing-tools': { label: 'Indexing Tools', icon: 'lucide:database-zap', color: 'text-accent-fg' },
  'routing-tools': { label: 'Gathering Tools Context', icon: 'lucide:route', color: 'text-accent-fg' },
  'finding-tools': { label: 'Finding Required Tools', icon: 'lucide:search-check', color: 'text-accent-fg' },
  'routing-memory': { label: 'Gathering Memory Context', icon: 'lucide:brain-circuit', color: 'text-accent-fg' },
  'curating-tools': { label: 'Refining Tool Context', icon: 'lucide:list-filter', color: 'text-accent-fg' },
  'curating-memory': { label: 'Refining Memory Context', icon: 'lucide:list-filter', color: 'text-accent-fg' },
  'awaiting-approval': { label: 'Awaiting approval', icon: 'lucide:shield-question', color: 'text-status-warning' },
  denied: { label: 'Denied', icon: 'lucide:shield-x', color: 'text-status-danger' },
  executing: FALLBACK_META,
  'ma-status': { label: 'Orchestrator', icon: 'lucide:network', color: 'text-status-violet' },
  'ma-subagent-running': { label: 'Sub-agent running', icon: 'lucide:bot', color: 'text-status-indigo' },
  'ma-subagent-done': { label: 'Sub-agent done', icon: 'lucide:check', color: 'text-status-success' },
  'ma-subagent-failed': { label: 'Sub-agent failed', icon: 'lucide:x', color: 'text-status-danger' },
  'ma-done': { label: 'Complete', icon: 'lucide:check-circle-2', color: 'text-status-success' },
  'ma-error': { label: 'Error', icon: 'lucide:alert-circle', color: 'text-status-danger' },
  'ma-file': { label: 'File', icon: 'lucide:file-text', color: 'text-ink-secondary' },
  'memory-retrieved': { label: 'Memory retrieved', icon: 'lucide:database', color: 'text-accent-fg' },
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
  return status ? STATUS_META[status] ?? { label: status, icon: 'lucide:circle', color: 'text-ink-secondary' } : FALLBACK_META
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
  return name === 'spawn_subagent' || name === 'continue_subagent'
}

function isMemoryCall(call?: Pick<ToolCall, 'arguments'> | null): boolean {
  return argType(call) === 'memory'
}

function isKnowledgeGraphCall(call?: Pick<ToolCall, 'arguments'> | null): boolean {
  return isMemoryCall(call) && parseArgs(call?.arguments)?.memoryKind === 'knowledge'
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

function contextPhase(call?: ToolCall | null): string {
  return visibleText(call ? parseArgs(call.arguments)?.contextPhase : undefined) ?? ''
}

function contextSectionKind(status: string): ContextSectionKind | null {
  if (status.endsWith('-tools')) return 'tool'
  if (status.endsWith('-memory')) return 'memory'
  return null
}

function contextCallKind(call: ToolCall, status: string): ContextSectionKind | null {
  if (isKnowledgeGraphCall(call)) return 'entity'
  return contextSectionKind(status)
}

function toolDisplayName(name = 'Tool'): string {
  if (name === 'Task context') return 'Preparing Context'
  if (name === 'spawn_subagent') return 'Spawn sub-agent'
  if (name === 'continue_subagent') return 'Continue sub-agent'
  return toolsByName.value.get(name)?.name ?? name
}

function memoryFileName(call?: ToolCall | null): string | null {
  if (!call || !isMemoryCall(call)) return null
  const parsed = parseArgs(call.arguments)
  return visibleText(parsed?.sourceFile) ?? (parsed?.memoryKind === 'knowledge' ? call.name : null)
}

function scoreForCall(call?: ToolCall | null): string | null {
  if (!call) return null
  const parsed = parseArgs(call.arguments)
  if (isMemoryCall(call)) return normalizeScore(parsed?.matchScore ?? parsed?.rerankerScore)
  if (isToolRouterCall(call)) return normalizeScore(parsed?.routerScore)
  return null
}

function scoreTitleForCall(call: ToolCall): string {
  if (isToolRouterCall(call)) return 'Tool match score'

  const parsed = parseArgs(call.arguments)
  const scoreType = visibleText(parsed?.scoreType)
  if (scoreType === 'fusion') return 'Relative retrieval match (combined query ranks)'
  if (scoreType === 'dense') return 'Semantic retrieval match'
  if (scoreType === 'lexical') return 'Lexical retrieval match (BM25)'
  if (scoreType === 'entity-resolution') return 'Entity resolution confidence'
  if (scoreType === 'reranker' || typeof parsed?.rerankerScore === 'number') return 'Reranker match score'
  return 'Memory match score'
}

function callContent(call?: ToolCall | null): string | null {
  if (!call || (!isMemoryCall(call) && !isToolRouterCall(call))) return null
  return visibleText(parseArgs(call.arguments)?.content)
}

function subAgentCodenameFromArgs(args: string): string | null {
  return visibleText(parseArgs(args)?.codename)
}

function formatElapsed(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function formatTimestamp(timestamp?: number): string {
  if (!timestamp) return ''
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(timestamp)
}

function isInternalExecution(execution: ToolExecution): boolean {
  return isBuiltInTool(execution.call?.name || execution.result?.name)
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
    return ['memory', call.name, parsed.sourceFile, parsed.directoryPath, parsed.chunkIndex, parsed.content]
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

    let finalIndex = sections.findIndex((candidate, candidateIndex) =>
      candidateIndex > index &&
      !consumed.has(candidateIndex) &&
      candidate.kind === section.kind &&
      candidate.phase === 'gathered-context',
    )

    // Memory chunks and graph relationships are emitted by one curation
    // pass. If one channel selects nothing, use the other channel's terminal
    // event so rejected candidates still appear as rejected under their own
    // heading instead of looking like an unfinished retrieval pass.
    if (section.phase === 'gathered-results' && finalIndex === -1 && (section.kind === 'memory' || section.kind === 'entity')) {
      finalIndex = sections.findIndex((candidate, candidateIndex) =>
        candidateIndex > index &&
        (candidate.kind === 'memory' || candidate.kind === 'entity') &&
        candidate.phase === 'gathered-context',
      )
      if (finalIndex !== -1 && sections[finalIndex].kind !== section.kind) {
        merged.push({
          ...section,
          phase: 'gathered-context',
          rows: section.executions.map((execution) => ({ ...execution, state: 'candidate' as const })),
        })
        consumed.add(index)
        return
      }
    }

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
  const channel = section.kind === 'tool'
    ? 'Tools'
    : section.kind === 'memory' ? 'Memory chunks' : section.kind === 'entity' ? 'Entity relationships' : ''

  if (section.phase === 'gathered-results') {
    return channel ? `Gathered ${channel} results` : 'Gathered Results'
  }

  if (section.phase === 'gathered-context') {
    return channel || 'Gathered Context'
  }

  if (section.status === 'routing-tools' || section.status === 'routing-memory') return channel ? `Gathering ${channel}` : 'Gathering Context'
  if (section.status === 'curating-tools' || section.status === 'curating-memory') return channel ? `Curating ${channel}` : 'Curating Context'

  return meta(section.status).label
}

function isCuratedContext(section: Pick<ContextSection, 'status' | 'phase'>): boolean {
  return section.phase === 'gathered-context' || section.status === 'curating-tools' || section.status === 'curating-memory'
}

function contextSectionIcon(section: ContextSection): string {
  if (section.kind === 'entity') return 'lucide:network'
  if (isCuratedContext(section)) return section.kind === 'memory' ? 'lucide:database' : 'lucide:package-check'
  return section.kind === 'memory' ? 'lucide:brain-circuit' : 'lucide:database'
}

function contextSectionClass(section: ContextSection): string {
  if (section.kind === 'entity') {
    return isCuratedContext(section)
      ? 'border-violet-400/30 bg-violet-500/5 dark:border-violet-500/25 dark:bg-violet-500/5'
      : 'border-indigo-400/25 bg-indigo-500/5 dark:border-indigo-500/20 dark:bg-indigo-500/5'
  }
  return isCuratedContext(section)
    ? 'border-teal-400/30 bg-teal-500/5 dark:border-teal-500/25 dark:bg-teal-500/5'
    : 'border-sky-400/25 bg-sky-500/5 dark:border-sky-500/20 dark:bg-sky-500/5'
}

function contextSectionIconClass(section: ContextSection): string {
  if (section.kind === 'entity') return 'text-status-violet dark:text-violet-300'
  return isCuratedContext(section) ? 'text-cyan-600 dark:text-cyan-300' : 'text-cyan-500 dark:text-cyan-400'
}

function contextSectionOrder(section: Pick<ContextSection, 'kind'>): number {
  if (section.kind === 'entity') return 0
  if (section.kind === 'tool') return 1
  if (section.kind === 'memory') return 2
  return 3
}

function toolChipClass(name: string): string {
  return isBuiltInTool(name)
    ? 'bg-purple-500/10 text-purple-600 ring-1 ring-purple-400/25 dark:text-purple-300 dark:ring-purple-500/20'
    : 'bg-accent-200/40 text-accent-700 dark:bg-accent-500/10 dark:text-accent-fg'
}

function toolCallIcon(call?: ToolCall | null): string {
  if (!call) return 'lucide:terminal'
  if (isAttachmentIndexCall(call)) return 'lucide:paperclip'
  if (isTaskContextCall(call)) return 'lucide:compass'
  if (isSubAgentSpawnCall(call.name)) return 'lucide:bot'
  if (isKnowledgeGraphCall(call)) return 'lucide:network'
  if (isMemoryCall(call)) return 'lucide:database'
  return 'lucide:terminal'
}

function toolCallIconClass(call?: ToolCall | null): string {
  if (!call) return 'text-ink-muted'
  if (isAttachmentIndexCall(call)) return 'text-sky-600 dark:text-sky-300'
  if (isTaskContextCall(call)) return 'text-cyan-600 dark:text-cyan-300'
  if (isKnowledgeGraphCall(call)) return 'text-status-violet dark:text-violet-300'
  if (isBuiltInTool(call.name)) return 'text-purple-500 dark:text-purple-300'
  return isSubAgentSpawnCall(call.name) ? 'text-status-indigo' : 'text-accent-fg'
}

function executionIcon(execution: ToolExecution): string {
  if (!execution.result) return toolCallIcon(execution.call)
  return execution.result.success ? 'lucide:check' : 'lucide:x'
}

function executionIconClass(execution: ToolExecution): string {
  if (!execution.result) return toolCallIconClass(execution.call)
  return execution.result.success ? 'text-status-success' : 'text-status-danger'
}

function executionCardClass(execution: ToolExecution | ContextRow): string {
  const tone = isInternalExecution(execution)
    ? 'bg-purple-50/80 border-purple-300/30 dark:bg-purple-500/5 dark:border-purple-500/20'
    : 'bg-accent-500/5 border-accent-500/20'
  return isCandidateRow(execution) ? `${tone} opacity-70` : tone
}

function executionNameClass(execution: ToolExecution | ContextRow): string {
  const tone = isInternalExecution(execution) ? 'text-purple-600 dark:text-purple-300' : 'text-accent-fg'
  return isCandidateRow(execution) ? `${tone} line-through decoration-theme-500/70` : tone
}

function scoreBadgeClass(execution: ToolExecution | ContextRow): string {
  return isCandidateRow(execution)
    ? 'bg-theme-800/70 text-ink-muted ring-theme-700/60 dark:bg-theme-800/50 dark:text-ink-muted dark:ring-theme-700/50'
    : 'bg-accent-100/70 text-accent-700 ring-accent-300/50 dark:bg-accent-500/10 dark:text-accent-fg dark:ring-accent-500/20'
}

function headerButtonClass(isExpanded: boolean): string {
  if (isTaskContext.value) {
    return isExpanded
      ? 'bg-cyan-100/60 border border-cyan-400/40 shadow-md shadow-cyan-500/5 dark:bg-cyan-950/20 dark:border-cyan-500/30 dark:shadow-cyan-950/10'
      : 'bg-cyan-50/80 hover:bg-cyan-100/60 hover:border-cyan-400/35 border border-cyan-300/30 dark:bg-cyan-950/10 dark:hover:bg-cyan-950/20 dark:hover:border-cyan-500/25 dark:border-cyan-500/15'
  }

  if (isToolRouting.value || isMemoryRouting.value) {
    return isExpanded
      ?'bg-green-100/60 border border-green-400/40 shadow-md shadow-green-500/5 dark:bg-green-950/20 dark:border-green-500/30 dark:shadow-green-950/10'
      : 'bg-green-50/80 hover:bg-green-100/60 hover:border-green-400/35 border border-green-300/30 dark:bg-green-950/10 dark:hover:bg-green-950/20 dark:hover:border-green-500/25 dark:border-green-500/15'
  }

  return isExpanded
    ? 'bg-theme-800 border border-theme-700/60 shadow-md'
    : 'bg-theme-800/60 hover:bg-theme-800 hover:border-theme-700/50 border border-transparent'
}

const latestStep = computed(() => props.steps.at(-1))
const currentStatus = computed(() => latestStep.value?.status ?? 'executing')
const currentPhase = computed(() => meta(currentStatus.value))

const latestToolCalls = computed(() => [...props.steps].reverse().find((step) => step.toolCalls?.length)?.toolCalls ?? [])

const results = computed(() => {
  if (props.delegationHandoff) return []
  return [...props.steps].reverse().find((step) => step.results?.length)?.results ?? []
})

const toolNames = computed(() => latestToolCalls.value.map((call) => call.name))

const isTaskContext = computed(() => props.steps.some((step) => step.status === 'building-task-context' || step.toolCalls?.some(isTaskContextCall)))
const isAttachmentIndexing = computed(() => props.steps.some((step) => step.status === 'indexing-attachments' || step.toolCalls?.some(isAttachmentIndexCall)))
const isToolRouting = computed(() => currentStatus.value === 'indexing-tools' || currentStatus.value === 'routing-tools' || currentStatus.value === 'finding-tools' || currentStatus.value === 'curating-tools')
const isMemoryRouting = computed(() => currentStatus.value === 'routing-memory' || currentStatus.value === 'curating-memory')
const isRoutingStatus = computed(() => isTaskContext.value || isAttachmentIndexing.value || isToolRouting.value || isMemoryRouting.value)

const routingStatusSteps = computed(() => {
  const seen = new Set<string>()
  return props.steps
    .filter((step) => [
      'routing-tools',
      'indexing-tools',
      'finding-tools',
      'curating-tools',
      'routing-memory',
      'curating-memory',
    ].includes(step.status))
    .filter((step) => {
      const key = `${step.status}:${step.message || ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
})

const successfulResultCount = computed(() => results.value.filter((result) => result.success).length)
const resultImages = computed(() => results.value.flatMap((result) => result.images?.filter(Boolean) ?? []))
const resultFileArtifacts = computed(() => {
  const seen = new Set<string>()
  return results.value.flatMap((result) => fileArtifactLinks(result.output)).filter((artifact) => {
    const key = fileArtifactKey(artifact.href)
    if (seen.has(key) || resultImages.value.some((image) => fileArtifactKey(image) === key)) return false
    seen.add(key)
    return true
  })
})
const resultOutcome = computed<ResultOutcomeMeta | null>(() => {
  if (!results.value.length) return null
  if (successfulResultCount.value === results.value.length) {
    return {
      label: 'Success',
      icon: 'lucide:check-circle',
      color: 'text-status-success/70 dark:text-status-success/70',
    }
  }
  if (successfulResultCount.value > 0) {
    return {
      label: 'Partial success',
      icon: 'lucide:triangle-alert',
      color: 'text-amber-600/80 dark:text-status-warning/80',
    }
  }
  return {
    label: 'Failed',
    icon: 'lucide:alert-circle',
    color: 'text-status-danger/70 dark:text-status-danger/70',
  }
})

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
  const parsed = parseArgs(latestToolCalls.value.find(isTaskContextCall)?.arguments)
  if (!parsed) return null

  const memorySearchQueries = Array.isArray(parsed.memorySearchQueries)
    ? parsed.memorySearchQueries.map(visibleText).filter((query): query is string => Boolean(query))
    : []

  return {
    toolQuery: visibleText(parsed.toolSearchQuery) ?? visibleText(parsed.toolQuery) ?? '',
    memoryQuery: memorySearchQueries[0] ?? visibleText(parsed.memoryQuery) ?? '',
    content: visibleText(parsed.content) ?? '',
    emptyReason: visibleText(parsed.emptyReason) ?? '',
  }
})

const taskContextTimestamp = computed(() =>
  props.steps.find((step) => step.status === 'building-task-context' || step.toolCalls?.some(isTaskContextCall))?.timestamp,
)

const taskContextQueries = computed(() => [
  { label: 'Tools', value: taskContext.value?.toolQuery ?? '' },
  { label: 'Memory', value: taskContext.value?.memoryQuery ?? '' },
].filter((query) => query.value))

const taskContextQueryLabels = computed(() => taskContextQueries.value.map((query) => query.label))

const contextSections = computed<ContextSection[]>(() => props.steps
  .filter((step) => step.toolCalls?.length && !step.toolCalls.some(isTaskContextCall))
  .flatMap((step) => {
    const calls = (step.toolCalls ?? []).filter(isContextGatheringCall)
    const grouped = new Map<ContextSectionKind, ToolCall[]>()
    for (const call of calls) {
      const kind = contextCallKind(call, step.status)
      if (!kind) continue
      grouped.set(kind, [...(grouped.get(kind) || []), call])
    }
    return [...grouped.entries()].map(([kind, channelCalls]) => ({
      status: step.status,
      phase: contextPhase(channelCalls[0]),
      kind,
      timestamp: step.timestamp,
      calls: channelCalls,
      executions: buildExecutions(channelCalls),
    }))
  }))

const mergedContextSections = computed(() => mergeContextSections(contextSections.value))
const toolExecutions = computed(() => buildExecutions(latestToolCalls.value, results.value))
const latestContextSection = computed(() => [...mergedContextSections.value].reverse()[0])
const finalContextSections = computed(() => mergedContextSections.value.filter((section) => section.phase === 'gathered-context'))
const hasFinalContext = computed(() => finalContextSections.value.length > 0)
const isRoutingWorkPending = computed(() => {
  if (!props.isActive || !isRoutingStatus.value) return false
  if (isTaskContext.value) return !latestToolCalls.value.some(isTaskContextCall)
  if (isAttachmentIndexing.value) return !latestToolCalls.value.some(isAttachmentIndexCall)
  return !hasFinalContext.value
})

function isRoutingStepLoading(step: ToolExecStep): boolean {
  return isRoutingWorkPending.value && routingStatusSteps.value.at(-1) === step
}

const headerToolNames = computed(() => {
  if (hasFinalContext.value) {
    const orderedFinalSections = [...finalContextSections.value]
      .sort((a, b) => contextSectionOrder(a) - contextSectionOrder(b))
    return [...new Set(orderedFinalSections.flatMap((section) => {
      const selectedRows = section.rows.filter((row) => row.state !== 'candidate')
      if (!selectedRows.length) return []
      if (section.kind === 'entity') return ['Entity relationships']
      if (section.kind === 'memory') {
        return ['Memory chunks', ...selectedRows
          .map((row) => memoryFileName(row.call))
          .filter((name): name is string => Boolean(name))]
      }
      return ['Tools', ...selectedRows
        .map((row) => row.call?.name || row.result?.name)
        .filter((name): name is string => Boolean(name))]
    }))]
  }

  if (latestContextSection.value?.kind === 'memory') {
    const visibleRows = latestContextSection.value.phase === 'gathered-context'
      ? latestContextSection.value.rows.filter((row) => row.state !== 'candidate')
      : latestContextSection.value.rows

    return [...new Set(visibleRows
      .map((row) => memoryFileName(row.call))
      .filter((name): name is string => Boolean(name))
    )]
  }

  if (latestContextSection.value?.phase === 'gathered-context') {
    const selectedRows = latestContextSection.value.rows.filter((row) => row.state !== 'candidate')

    const names = selectedRows.map((row) => row.call?.name || row.result?.name)

    return [...new Set(names
      .filter((name): name is string => Boolean(name))
    )]
  }

  return toolNames.value
})

const contextExecutionSections = computed<ContextExecutionSection[]>(() => {
  if (isTaskContext.value) return []
  return [...mergedContextSections.value]
    .sort((a, b) => contextSectionOrder(a) - contextSectionOrder(b))
    .map((section, index) => ({
      key: `${section.status}-${section.phase}-${index}`,
      title: contextSectionTitle(section),
      icon: contextSectionIcon(section),
      class: contextSectionClass(section),
      iconClass: contextSectionIconClass(section),
      rows: section.rows,
      isLoading: props.isActive && index === mergedContextSections.value.length - 1 && section.phase === 'gathered-results',
      timestamp: section.timestamp,
      tone: section.kind === 'entity' ? 'violet' : 'green',
    }))
})

const headerLabel = computed(() => {
  if (isTaskContext.value || isAttachmentIndexing.value) return currentPhase.value.label

  if (hasFinalContext.value) return 'Gathered Context'

  return currentPhase.value.label
})

const headerIcon = computed(() => {
  if (props.delegationHandoff) return 'lucide:corner-down-right'
  if (currentPhase.value.label === 'Denied') return 'lucide:shield-x'
  if (isRoutingWorkPending.value) return 'svg-spinners:ring-resize'
  if (isRoutingStatus.value) return currentPhase.value.icon
  if (headerToolNames.value.length && !results.value.length) return props.isActive ? 'svg-spinners:ring-resize' : 'lucide:circle-slash'
  if (resultOutcome.value) return resultOutcome.value.icon
  return currentPhase.value.icon
})

const headerIconClass = computed(() => {
  if (props.delegationHandoff) return 'text-status-indigo'
  if (currentPhase.value.label === 'Denied') return 'text-status-danger'
  if (isRoutingWorkPending.value) return 'text-accent-fg'
  if (isTaskContext.value) return 'text-cyan-600 dark:text-cyan-300'
  if (isRoutingStatus.value) return 'text-accent-fg'
  if (headerToolNames.value.length && !results.value.length) return props.isActive ? 'text-accent-fg' : 'text-ink-muted'
  if (resultOutcome.value) return resultOutcome.value.color
  return currentPhase.value.color
})

const executionRows = computed(() => toolExecutions.value.map((execution) => {
  const name = execution.call?.name || execution.result?.name || 'Tool'
  return {
    ...execution,
    name: toolDisplayName(name),
    icon: toolNamespaceIcon(name),
    iconUrl: toolIconUrl(name),
    internal: isBuiltInTool(name),
  }
}))

const hasDisplayableActivity = computed(() =>
  isTaskContext.value ||
  isRoutingStatus.value ||
  latestToolCalls.value.length > 0 ||
  results.value.length > 0 ||
  Boolean(streamingText.value && props.isActive),
)
</script>

<template>
  <div
    v-if="hasDisplayableActivity"
    class="px-4 py-1.5"
  >
    <div
      class="ml-3 md:ml-12"
      :class="isTaskContext || isRoutingStatus ? 'max-w-[80%]' : ''"
    >
      <ToolExecutionList
        v-if="!isTaskContext && !isRoutingStatus && executionRows.length"
        :rows="executionRows"
        :is-active="isActive"
        :status="currentPhase.label"
        :streaming-text="streamingText?.text"
        @preview-image="lightboxSrc = $event"
      />
      <CollapsibleSection
        v-else
        v-model="expanded"
      >
        <template #trigger="{ expanded: isExpanded, toggle, triggerAttrs }">
          <button
            v-bind="triggerAttrs"
            class="w-full flex items-center gap-2 px-3 py-2 rounded-2xl text-[13px] font-medium transition-all group shadow-sm"
            :class="[
              headerButtonClass(isExpanded),
            ]"
            @click="toggle"
          >
            <Icon
              :icon="headerIcon"
              class="w-3.5 h-3.5 shrink-0"
              :class="headerIconClass"
            />

            <span
              v-if="maContext?.codename"
              class="text-[10px] text-status-indigo/80 dark:text-status-indigo/80 truncate max-w-16"
              :title="maContext.agentName || maContext.codename"
            >{{ maContext.codename }}</span>
            <span
              v-else-if="maContext?.phase"
              class="text-[10px] text-status-violet/80"
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
                  class="text-[10px] text-ink-muted"
                >+{{ taskContextQueryLabels.length - 3 }}</span>
              </template>

              <template v-else-if="headerToolNames.length">
                <span
                  v-if="delegationHandoff"
                  class="text-status-indigo shrink-0"
                >Delegation requested</span>
                <span
                  v-if="isRoutingStatus"
                  class="text-ink-secondary shrink-0"
                  :class="currentPhase.color"
                >{{ headerLabel }}</span>
                <span
                  v-for="name in headerToolNames.slice(0, 3)"
                  :key="name"
                  class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium truncate max-w-35"
                  :class="toolChipClass(name)"
                >
                  <ToolNamespaceIcon
                    :src="toolIconUrl(name)"
                    :icon="toolNamespaceIcon(name)"
                    class="h-4 w-4 bg-current/10"
                  />
                  {{ toolDisplayName(name) }}
                </span>
                <span
                  v-if="headerToolNames.length > 3"
                  class="text-[10px] text-ink-muted"
                >+{{ headerToolNames.length - 3 }}</span>
              </template>

              <span
                v-else
                class="text-ink-secondary"
                :class="currentPhase.color"
              >{{ headerLabel }}</span>
            </div>

            <span
              v-if="!isExpanded && resultImages.length"
              class="relative h-8 w-10 shrink-0 overflow-hidden rounded-md border border-theme-600/70 bg-theme-900/70 shadow-sm"
              :aria-label="`${resultImages.length} returned image${resultImages.length === 1 ? '' : 's'}`"
            >
              <img
                :src="resultImages[0]"
                alt=""
                class="h-full w-full object-cover"
              >
              <span
                v-if="resultImages.length > 1"
                class="absolute bottom-0 right-0 rounded-tl bg-theme-950/85 px-1 text-[9px] leading-4 text-theme-200"
              >+{{ resultImages.length - 1 }}</span>
            </span>

            <FileArtifactLinks
              v-if="!isExpanded && resultFileArtifacts.length"
              :artifacts="resultFileArtifacts"
              :limit="1"
              compact
            />

            <span
              v-if="resultOutcome"
              class="text-[10px] shrink-0"
              :class="resultOutcome.color"
            >{{ successfulResultCount }}/{{ results.length }} ok · {{ resultOutcome.label }}</span>

            <span
              v-if="elapsedMs > 0"
              class="text-[10px] text-ink-faint tabular-nums shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
            >{{ formatElapsed(elapsedMs) }}</span>

            <Icon
              icon="lucide:chevron-down"
              class="w-3 h-3 text-ink-faint shrink-0 transition-transform"
              :class="{ 'rotate-180': isExpanded }"
            />
          </button>
        </template>

        <div
          v-if="streamingText && isActive"
          class="mt-1.5 ml-3 px-3 py-2 rounded-lg bg-theme-800/50 border border-theme-700/30"
        >
          <span class="text-[10px] text-ink-muted font-medium block mb-0.5">{{ streamingText.label }}</span>
          <p class="text-[11px] text-ink-secondary whitespace-pre-wrap">
            {{ streamingText.text }}<span class="inline-block w-1.5 h-3 bg-theme-400/60 animate-pulse ml-0.5 align-middle" />
          </p>
        </div>

        <div
          class="mt-1.5 ml-3 space-y-2"
          :class="{ 'context-timeline': isRoutingStatus }"
        >
          <div
            v-if="routingStatusSteps.length && (isToolRouting || isMemoryRouting || mergedContextSections.length)"
            class="context-timeline-item context-timeline-item--cyan rounded-lg border border-sky-400/25 bg-sky-500/5 px-2.5 py-2 dark:border-sky-500/20 dark:bg-sky-500/5"
          >
            <div class="mb-1 flex items-center justify-between gap-3">
              <span class="text-[11px] font-semibold text-cyan-700 dark:text-cyan-200">Gathering context</span>
              <time class="text-[10px] tabular-nums text-ink-faint">{{ formatTimestamp(routingStatusSteps[0]?.timestamp) }}</time>
            </div>
            <div
              v-for="step in routingStatusSteps"
              :key="`${step.status}-${step.timestamp}`"
              class="flex items-center gap-2 py-1 text-[11px]"
            >
              <Icon
                :icon="isRoutingStepLoading(step) ? 'svg-spinners:ring-resize' : meta(step.status).icon"
                class="h-3 w-3 shrink-0"
                :class="meta(step.status).color"
              />
              <span class="font-medium text-theme-300">{{ meta(step.status).label }}</span>
              <span
                v-if="step.message"
                class="min-w-0 truncate text-ink-muted"
              >{{ step.message }}</span>
            </div>
          </div>

          <div
            v-if="isTaskContext && taskContext"
            class="context-timeline-item context-timeline-item--cyan rounded-lg border border-cyan-300/30 bg-cyan-50/80 px-3 py-2 dark:border-cyan-500/15 dark:bg-cyan-500/5"
          >
            <div class="flex items-center gap-1.5 mb-1.5">
              <Icon
                icon="lucide:compass"
                class="w-3 h-3 text-cyan-600 dark:text-cyan-300"
              />
              <span class="text-[11px] font-medium text-cyan-700 dark:text-cyan-200">Preparing context</span>
              <time class="ml-auto text-[10px] tabular-nums text-ink-faint">{{ formatTimestamp(taskContextTimestamp) }}</time>
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
                <p class="mt-0.5 text-[11px] leading-relaxed text-ink-secondary whitespace-pre-wrap wrap-break-word">
                  {{ query.value }}
                </p>
              </div>
            </div>

            <p
              v-else-if="taskContext.content"
              class="rounded-md bg-cyan-50/50 px-2 py-1.5 text-[11px] leading-relaxed text-ink-secondary whitespace-pre-wrap dark:bg-theme-950/35"
            >
              {{ taskContext.content }}
            </p>
          </div>

          <ToolExecutionList
            v-if="!isTaskContext && !mergedContextSections.length && executionRows.length"
            :rows="executionRows"
            :is-active="isActive"
            :status="currentPhase.label"
            @preview-image="lightboxSrc = $event"
          />

          <div
            v-for="section in contextExecutionSections"
            :key="section.key"
            :class="['context-timeline-item rounded-lg border px-2.5 py-2', `context-timeline-item--${section.tone}`, section.class]"
          >
            <div
              class="mb-1.5 flex items-center gap-1.5"
            >
              <Icon
                :icon="section.isLoading ? 'svg-spinners:ring-resize' : section.icon"
                class="h-3 w-3"
                :class="section.iconClass"
              />
              <span class="text-[11px] font-semibold text-theme-300">{{ section.title }}</span>
              <time class="ml-auto text-[10px] tabular-nums text-ink-faint">{{ formatTimestamp(section.timestamp) }}</time>
            </div>

            <div class="space-y-1.5">
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
                  <ToolNamespaceIcon
                    :src="toolIconUrl(execution.call?.name || execution.result?.name)"
                    :icon="toolNamespaceIcon(execution.call?.name || execution.result?.name)"
                    class="h-5 w-5 bg-current/10"
                    :class="executionNameClass(execution)"
                  />
                  <span
                    class="text-[11px] font-medium"
                    :class="executionNameClass(execution)"
                  >{{ toolDisplayName(execution.call?.name || execution.result?.name) }}</span>

                  <span
                    v-if="execution.call && scoreForCall(execution.call)"
                    class="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1"
                    :class="scoreBadgeClass(execution)"
                    :title="scoreTitleForCall(execution.call)"
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

                <RichContent
                  v-if="callContent(execution.call)"
                  :content="callContent(execution.call)"
                  class="max-h-64 rounded bg-theme-900/70 px-2 py-1.5 dark:bg-theme-950/50"
                />
              </div>
            </div>
          </div>
        </div>
      </CollapsibleSection>
    </div>
  </div>

  <ArtifactImageModal
    :src="lightboxSrc"
    @close="lightboxSrc = null"
  />
</template>

<style scoped>
.context-timeline {
  position: relative;
  margin-top: .375rem;
  margin-left: 0;
  padding: .25rem .25rem .25rem 1.75rem;
  border: 0;
  background: transparent;
}

.context-timeline::before {
  content: '';
  position: absolute;
  top: .9rem;
  bottom: .9rem;
  left: .7rem;
  width: 1px;
  background: color-mix(in srgb, var(--color-theme-600) 55%, transparent);
}

.context-timeline-item {
  position: relative;
  margin-bottom: .5rem;
  border-color: color-mix(in srgb, var(--color-theme-700) 55%, transparent) !important;
  background: color-mix(in srgb, var(--color-theme-800) 35%, transparent) !important;
}

.context-timeline-item:last-child {
  margin-bottom: 0;
}

.context-timeline-item::before {
  content: '';
  position: absolute;
  z-index: 1;
  top: 0.7rem;
  left: -1.35rem;
  width: .5rem;
  height: .5rem;
  border: 2px solid var(--color-theme-900);
  border-radius: 9999px;
  background: var(--color-theme-500);
  box-shadow: none;
}

.context-timeline-item--green::before {
  background: var(--color-theme-500);
  box-shadow: none;
}

.context-timeline-item--violet::before {
  background: var(--color-theme-500);
  box-shadow: none;
}

@media (max-width: 640px) {
  .context-timeline {
    padding-left: 1.5rem;
  }

  .context-timeline::before {
    left: .55rem;
  }

  .context-timeline-item::before {
    left: -1.2rem;
  }
}
</style>
