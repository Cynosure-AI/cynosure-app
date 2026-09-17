<script setup lang="ts">
import { computed, reactive } from 'vue'
import { Icon } from '@iconify/vue'
import type { ToolExecStep } from './ToolExecutionCard.vue'
import HoverTooltip from '../shared/HoverTooltip.vue'

type ToolCall = NonNullable<ToolExecStep['toolCalls']>[number]
type Channel = 'memory' | 'tools'
type Detail = {
  name: string
  content?: string
  score?: string
  scoreValue?: number
  namespaceId?: string
  namespaceLabel?: string
  memoryKind?: string
  matchedRepresentations?: string[]
  empty?: boolean
}
type PipelineItem = {
  key: string
  label: string
  summary?: string
  icon: string
  timestamp: number
  updatedAt: number
  details: Detail[]
  final: boolean
  pending: boolean
}
type MemoryPipelineStats = {
  queryCount: number
  searchCandidateCount: number
  rerankerInputCount: number
  rerankerOutputCount: number
  returnedCount: number
  uniqueCount: number
  filteredCount: number
  duplicateCount: number
  weakCount: number
  relativeScoreThreshold: number
  searchMatches?: Array<{
    name: string
    content: string
    matchScore: number
    scoreType?: string
    matchedRepresentations?: string[]
  }>
}
type ContextCard = {
  channel: Channel
  title: string
  icon: string
  items: PipelineItem[]
  latest: PipelineItem
  selected: Detail[]
  toolsets: Detail[]
  selectedTools: Detail[]
}

const props = defineProps<{ steps: ToolExecStep[]; isActive: boolean }>()
const expandedCards = reactive(new Set<Channel>())
const expandedSteps = reactive(new Set<string>())

const STATUS: Record<string, { channel: Channel; label: string; summary: string; icon: string }> = {
  'routing-memory': { channel: 'memory', label: 'Preparing memory retrieval', summary: 'Building the memory search', icon: 'lucide:brain-circuit' },
  'searching-memory': { channel: 'memory', label: 'Searching memory representations', summary: 'Searching raw chunks plus available summaries, keywords, and facts', icon: 'lucide:search' },
  'reranking-memory': { channel: 'memory', label: 'Reranking memory matches', summary: 'Reranker relevance scoring', icon: 'lucide:arrow-down-wide-narrow' },
  'filtering-memory': { channel: 'memory', label: 'Filtering memory matches', summary: 'Deduplicates repeated chunks and removes matches scoring below 65% of the strongest match', icon: 'lucide:list-filter' },
  'selecting-memory': { channel: 'memory', label: 'Selecting reranked memories', summary: 'Using the highest-ranked evidence', icon: 'lucide:badge-check' },
  'curating-memory': { channel: 'memory', label: 'AI curating memory evidence', summary: 'Final relevance verification', icon: 'lucide:list-checks' },
  'routing-tools': { channel: 'tools', label: 'Selecting MCPs and toolsets', summary: 'Choosing capability groups', icon: 'lucide:boxes' },
  'indexing-tools': { channel: 'tools', label: 'Indexing tool definitions', summary: 'Preparing semantic tool search', icon: 'lucide:database-zap' },
  'finding-tools': { channel: 'tools', label: 'Ranking tools', summary: 'Selecting tools within each toolset', icon: 'lucide:search-check' },
  'curating-tools': { channel: 'tools', label: 'Selecting final tools', summary: 'Final tool selection', icon: 'lucide:list-checks' },
}

function args(call: ToolCall): Record<string, unknown> {
  try {
    const value = JSON.parse(call.arguments || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value) ? value.map(stringValue).filter((item): item is string => Boolean(item)) : []
}

function normalizedScore(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(1, value > 1 ? value / 100 : value))
}

function memoryStats(value: unknown): MemoryPipelineStats | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Partial<MemoryPipelineStats>
  const keys: Array<keyof MemoryPipelineStats> = [
    'queryCount', 'searchCandidateCount', 'rerankerInputCount', 'rerankerOutputCount',
    'returnedCount', 'uniqueCount', 'filteredCount', 'duplicateCount', 'weakCount',
    'relativeScoreThreshold',
  ]
  return keys.every((key) => typeof candidate[key] === 'number') ? candidate as MemoryPipelineStats : undefined
}

function memoryStatusCopy(status: string, stats?: MemoryPipelineStats): { label: string; summary: string } | undefined {
  if (!stats) return undefined
  if (status === 'searching-memory') {
    return {
      label: `Hybrid search found ${plural(stats.searchCandidateCount, 'candidate')}`,
      summary: `Raw chunks and analyzed summary, keyword, and fact views across ${plural(stats.queryCount, 'query', 'queries')}`,
    }
  }
  if (status === 'reranking-memory' && stats.rerankerInputCount > 0) {
    return {
      label: `Reranked ${stats.rerankerInputCount} candidates down to ${plural(stats.rerankerOutputCount, 'match', 'matches')}`,
      summary: 'A reranker rescored candidates by relevance before filtering',
    }
  }
  if (status === 'filtering-memory') {
    const threshold = Math.round(stats.relativeScoreThreshold * 100)
    return {
      label: `Kept ${stats.filteredCount} of ${plural(stats.uniqueCount, 'unique match', 'unique matches')}`,
      summary: `Removed ${plural(stats.duplicateCount, 'cross-query duplicate')} and ${plural(stats.weakCount, 'weak match', 'weak matches')}; weak means below ${threshold}% of the strongest displayed relevance score`,
    }
  }
  return undefined
}

function details(calls: ToolCall[]): Detail[] {
  return calls.map((call) => {
    const parsed = args(call)
    const value = normalizedScore(parsed.routerScore ?? parsed.rerankerScore ?? parsed.matchScore)
    return {
      name: stringValue(parsed.sourceFile) || call.name,
      content: stringValue(parsed.content),
      score: value === undefined ? undefined : `${Math.round(value * 100)}%`,
      scoreValue: value,
      namespaceId: stringValue(parsed.namespaceId),
      namespaceLabel: stringValue(parsed.namespaceLabel),
      memoryKind: stringValue(parsed.memoryKind),
      matchedRepresentations: stringValues(parsed.matchedRepresentations),
      empty: Boolean(stringValue(parsed.emptyReason)),
    }
  }).sort((a, b) => (b.scoreValue ?? -1) - (a.scoreValue ?? -1))
}

function searchMatchDetails(stats?: MemoryPipelineStats): Detail[] {
  return (stats?.searchMatches || []).slice(0, 10).map((match) => {
    const score = normalizedScore(match.matchScore)
    return {
      name: match.name,
      content: match.content,
      score: score === undefined ? undefined : `${Math.round(score * 100)}%`,
      scoreValue: score,
      matchedRepresentations: stringValues(match.matchedRepresentations),
    }
  }).sort((a, b) => (b.scoreValue ?? -1) - (a.scoreValue ?? -1))
}

function selectionLabel(channel: Channel, calls: ToolCall[], final: boolean): string {
  const visible = calls.filter((call) => !stringValue(args(call).emptyReason))
  if (channel === 'memory') {
    if (!visible.length) return final ? 'No memories selected' : 'No memory matches found'
    if (!final) return `Found ${plural(visible.length, 'memory match', 'memory matches')}`
    const method = stringValue(args(visible[0]).selectionMethod)
    const memoryCount = visible.filter((call) => stringValue(args(call).memoryKind) !== 'knowledge').length
    const hasKnowledge = visible.some((call) => stringValue(args(call).memoryKind) === 'knowledge')
    const selected = method === 'reranker'
      ? `Selected top ${plural(memoryCount, 'memory', 'memories')}`
      : `Selected ${plural(memoryCount, 'memory item')}`
    return hasKnowledge ? `${selected} + knowledge context` : selected
  }
  const toolsets = calls.every((call) => args(call).type === 'toolset-router')
  if (toolsets) return visible.length
    ? `Selected ${plural(visible.length, 'MCP/toolset', 'MCPs/toolsets')}`
    : 'No MCPs or toolsets selected'
  return visible.length ? 'Tool selection complete' : 'No tools selected'
}

function plural(count: number, singular: string, pluralValue = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralValue}`
}

function selectedCountLabel(card: ContextCard): string {
  if (card.channel !== 'memory') return plural(card.selected.length, 'MCP/toolset', 'MCPs/toolsets')
  const memoryCount = card.selected.filter((item) => item.memoryKind !== 'knowledge').length
  const hasKnowledge = card.selected.some((item) => item.memoryKind === 'knowledge')
  return `${plural(memoryCount, 'memory', 'memories')}${hasKnowledge ? ' + graph' : ''}`
}

const cards = computed<ContextCard[]>(() => {
  const pipelines: Record<Channel, PipelineItem[]> = { memory: [], tools: [] }
  const taskContextStep = props.steps.find((step) => step.toolCalls?.some((call) => args(call).type === 'task-context'))
  const taskContext = taskContextStep?.toolCalls?.find((call) => args(call).type === 'task-context')
  const taskContextArgs = taskContext ? args(taskContext) : {}
  const channelQueries: Record<Channel, string[]> = {
    tools: [stringValue(taskContextArgs.toolSearchQuery) ?? stringValue(taskContextArgs.toolQuery)].filter((query): query is string => Boolean(query)),
    memory: [...new Set([
      ...stringValues(taskContextArgs.memorySearchQueries),
      ...stringValues(taskContextArgs.memoryQueries),
      ...(stringValue(taskContextArgs.memoryQuery) ? [stringValue(taskContextArgs.memoryQuery)!] : []),
    ])],
  }
  const latestMemoryStats = [...props.steps].reverse()
    .flatMap((step) => step.toolCalls || [])
    .map((call) => memoryStats(args(call).pipelineStats))
    .find((stats): stats is MemoryPipelineStats => Boolean(stats))

  props.steps.forEach((step, stepIndex) => {
    const calls = step.toolCalls || []
    const memoryCalls = calls.filter((call) => args(call).type === 'memory')
    const toolCalls = calls.filter((call) => ['toolset-router', 'tool-router'].includes(String(args(call).type)))

    const status = STATUS[step.status]
    const memoryPhase = memoryCalls.length ? stringValue(args(memoryCalls[0]).contextPhase) : undefined
    const memoryOutcomeAttached = status?.channel === 'memory' && Boolean(memoryPhase)
    const finalMemoryOutcome = memoryOutcomeAttached && memoryPhase === 'gathered-context'
    const supersededByMemoryOutcome = status?.channel === 'memory' && !memoryCalls.length && props.steps
      .slice(stepIndex + 1)
      .some((later) => later.taskId === step.taskId && later.status === step.status && (later.toolCalls || [])
        .some((call) => args(call).type === 'memory' && Boolean(stringValue(args(call).contextPhase))))
    if (status && !supersededByMemoryOutcome) {
      const statusCopy = status.channel === 'memory' ? memoryStatusCopy(step.status, latestMemoryStats) : undefined
      const firstChannelStep = pipelines[status.channel].length === 0
      const method = memoryOutcomeAttached ? stringValue(args(memoryCalls[0]).selectionMethod) : undefined
      const searchedMatches = step.status === 'searching-memory' ? searchMatchDetails(latestMemoryStats) : []
      pipelines[status.channel].push({
        key: `${status.channel}-${stepIndex}-${step.status}`,
        label: finalMemoryOutcome
          ? selectionLabel('memory', memoryCalls, true)
          : statusCopy?.label || (memoryOutcomeAttached
            ? step.status === 'filtering-memory'
              ? `Kept ${plural(memoryCalls.filter((call) => !stringValue(args(call).emptyReason)).length, 'memory match', 'memory matches')} after filtering`
              : selectionLabel('memory', memoryCalls, false)
            : step.message || status.label),
        summary: finalMemoryOutcome
          ? method === 'reranker' ? 'Final memories chosen by reranker score' : method === 'llm' ? 'Final memories chosen by AI relevance review' : 'Final highest-ranked memories'
          : statusCopy?.summary || status.summary,
        icon: finalMemoryOutcome ? 'lucide:check' : status.icon,
        timestamp: step.timestamp,
        updatedAt: step.updatedAt ?? step.timestamp,
        details: finalMemoryOutcome
          ? []
          : memoryOutcomeAttached
            ? details(memoryCalls)
            : searchedMatches.length
              ? searchedMatches
              : firstChannelStep ? channelQueries[status.channel].map((query) => ({ name: query })) : [],
        final: finalMemoryOutcome,
        pending: props.isActive && !calls.length && !props.steps.slice(stepIndex + 1).some((later) => later.taskId === step.taskId),
      })
    }

    for (const [channel, channelCalls] of [['memory', memoryCalls], ['tools', toolCalls]] as const) {
      if (!channelCalls.length) continue
      // Memory result calls are persisted onto the status step that produced
      // them. Render that as one completed stage, not a second pseudo-step.
      if (channel === 'memory' && memoryOutcomeAttached) continue
      const final = channel === 'memory'
        ? args(channelCalls[0]).contextPhase === 'gathered-context'
        : args(channelCalls[0]).type === 'tool-router' && args(channelCalls[0]).contextPhase === 'gathered-context'
      const method = stringValue(args(channelCalls[0]).selectionMethod)
      pipelines[channel].push({
        key: `${channel}-${stepIndex}-${String(args(channelCalls[0]).contextPhase || args(channelCalls[0]).type)}`,
        label: selectionLabel(channel, channelCalls, final),
        summary: method === 'reranker' ? 'Reranker selection' : method === 'llm' ? 'AI selection' : method === 'automatic' ? 'Included complete small toolset' : method === 'semantic' ? 'Embedding similarity' : method === 'lexical' ? 'Lexical matching' : 'Retrieval results',
        icon: final ? 'lucide:check' : channel === 'memory' ? 'lucide:brain' : args(channelCalls[0]).type === 'toolset-router' ? 'lucide:boxes' : 'lucide:wrench',
        timestamp: step.timestamp,
        updatedAt: step.updatedAt ?? step.timestamp,
        // Keep the effective final tool list on the completion item so users can
        // inspect tools that were retained independently of toolset routing.
        details: channel === 'tools' && args(channelCalls[0]).type === 'tool-router' && !final
          ? []
          : details(channelCalls),
        final,
        pending: false,
      })
    }

  })

  return (['memory', 'tools'] as Channel[]).flatMap((channel) => {
    const items = pipelines[channel]
    if (!items.length) return []
    const latest = items.reduce((current, item) => item.updatedAt >= current.updatedAt ? item : current)
    const toolsets = channel === 'tools'
      ? items.flatMap((item) => item.details.filter((detail) => item.key.includes('toolset-router') && !detail.empty))
      : []
    const finalMemoryCalls = channel === 'memory'
      ? [...props.steps].reverse()
        .map((step) => (step.toolCalls || []).filter((call) => (
          args(call).type === 'memory' && args(call).contextPhase === 'gathered-context'
        )))
        .find((calls) => calls.length > 0) || []
      : []
    const selected = channel === 'tools'
      ? toolsets
      : details(finalMemoryCalls).filter((detail) => !detail.empty)
    const selectedTools = channel === 'tools'
      ? props.steps.flatMap((step) => details((step.toolCalls || []).filter((call) => (
        args(call).type === 'tool-router' && args(call).contextPhase === 'gathered-context'
      )))).filter((detail) => !detail.empty)
      : []
    return [{ channel, title: channel === 'memory' ? 'Auto memory' : 'Auto tools', icon: channel === 'memory' ? 'lucide:brain-circuit' : 'lucide:wrench', items, latest, selected, toolsets, selectedTools }]
  })
})

function groupedAutoSelectedTools(card: ContextCard): Array<{ id: string; label: string; tools: Detail[] }> {
  const groups = new Map<string, { id: string; label: string; tools: Detail[] }>()
  for (const toolset of card.toolsets) {
    const id = toolset.namespaceId || toolset.name
    groups.set(id, { id, label: toolset.name, tools: [] })
  }
  for (const tool of card.selectedTools) {
    const fallback = card.toolsets.length === 1 ? card.toolsets[0] : undefined
    const id = tool.namespaceId || fallback?.namespaceId || fallback?.name
    if (id && groups.has(id)) groups.get(id)!.tools.push(tool)
  }
  return [...groups.values()]
}

function toggle(set: Set<string>, key: string): void {
  if (set.has(key)) set.delete(key)
  else set.add(key)
}

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(timestamp)
}
</script>

<template>
  <div
    v-if="cards.length"
    class="px-4 py-1.5"
  >
    <div class="ml-3 flex flex-col max-w-[50%] gap-2 md:ml-12">
      <article
        v-for="card in cards"
        :key="card.channel"
        class="pre-turn-card"
        :class="`pre-turn-card--${card.channel}`"
      >
        <button
          class="flex w-full items-center gap-2.5 px-3.5 py-3 text-left"
          :aria-expanded="expandedCards.has(card.channel)"
          @click="toggle(expandedCards, card.channel)"
        >
          <span class="card-icon">
            <Icon
              :icon="card.latest.pending ? 'svg-spinners:ring-resize' : card.icon"
              class="h-3.5 w-3.5"
            />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block text-[12px] font-semibold text-theme-200">{{ card.title }}</span>
            <span
              class="block truncate text-[11px] text-theme-400"
              role="status"
              aria-live="polite"
            >{{
              card.latest.label }}</span>
          </span>
          <span
            v-if="card.selected.length"
            class="count-chip"
          >{{ selectedCountLabel(card) }}</span>
          <Icon
            icon="lucide:chevron-down"
            class="h-3.5 w-3.5 text-theme-500 transition-transform"
            :class="{ 'rotate-180': expandedCards.has(card.channel) }"
          />
        </button>

        <div
          v-if="!expandedCards.has(card.channel) && card.selected.length"
          class="collapsed-results"
          :aria-label="`${card.title} selected results`"
        >
          <span
            v-for="(result, index) in card.selected"
            :key="`${result.name}-${index}`"
            class="collapsed-result-chip"
            :title="result.name"
          >
            <span class="truncate">{{ result.name }}</span>
            <small v-if="result.score">{{ result.score }}</small>
          </span>
        </div>

        <div
          v-if="expandedCards.has(card.channel)"
          class="border-t border-theme-700/35 px-3 py-3"
        >
          <ol
            class="space-y-1"
            :aria-label="`${card.title} pipeline`"
          >
            <li
              v-for="item in card.items"
              :key="item.key"
            >
              <button
                class="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-theme-800/35"
                :class="{ 'cursor-default': !item.details.length }"
                :aria-expanded="item.details.length ? expandedSteps.has(item.key) : undefined"
                @click="item.details.length && toggle(expandedSteps, item.key)"
              >
                <Icon
                  :icon="item.pending ? 'svg-spinners:ring-resize' : item.icon"
                  class="mt-0.5 h-3.5 w-3.5 shrink-0"
                />
                <span class="min-w-0 flex-1"><span class="block text-[11px] font-medium text-theme-300">{{ item.label
                }}</span><span
                  v-if="item.summary"
                  class="block text-[10px] text-theme-500"
                >{{ item.summary
                }}</span></span>
                <time class="text-[9px] tabular-nums text-theme-600">{{ formatTimestamp(item.timestamp) }}</time>
                <Icon
                  v-if="item.details.length"
                  icon="lucide:chevron-right"
                  class="mt-0.5 h-3 w-3 text-theme-600 transition-transform"
                  :class="{ 'rotate-90': expandedSteps.has(item.key) }"
                />
              </button>
              <div
                v-if="item.details.length && expandedSteps.has(item.key)"
                class="ml-7 space-y-1 rounded-lg bg-theme-950/35 p-2"
                :aria-label="card.channel === 'tools' && item.final ? 'All tools included this round' : undefined"
              >
                <div
                  v-for="(detail, index) in item.details"
                  :key="`${detail.name}-${index}`"
                  class="text-[10px] text-theme-400"
                >
                  <span class="font-medium">{{ detail.name }}</span><span
                    v-if="detail.score"
                    class="ml-2 context-score-text"
                  >{{ detail.score }}</span>
                  <span
                    v-if="detail.matchedRepresentations?.length"
                    class="ml-2 text-theme-500"
                  >via {{ detail.matchedRepresentations.join(' + ') }}</span>
                  <p
                    v-if="detail.content && item.key.includes('searching-memory')"
                    class="mt-0.5 line-clamp-2 leading-relaxed text-theme-500"
                  >
                    {{ detail.content }}
                  </p>
                </div>
              </div>
            </li>
          </ol>

          <div
            v-if="card.channel === 'memory' && card.selected.length"
            class="memory-grid mt-3"
            aria-label="Selected memories"
          >
            <HoverTooltip
              v-for="(memory, index) in card.selected"
              :key="`${memory.name}-${index}`"
              :disabled="!memory.content"
              placement="mouse"
              :max-width="480"
              block
            >
              <article class="memory-card w-full">
                <div class="flex items-start gap-2">
                  <h4
                    class="memory-title min-w-0 flex-1 truncate text-[11px] font-semibold"
                    :title="memory.name"
                  >
                    {{ memory.name }}
                  </h4><span
                    v-if="memory.score"
                    class="score-chip"
                  >{{ memory.score }}</span>
                </div>
                <div
                  v-if="memory.matchedRepresentations?.length"
                  class="mt-1 text-[9px] text-theme-500"
                >Matched via {{ memory.matchedRepresentations.join(' + ') }}</div>
                <p
                  v-if="memory.content"
                  class="mt-1.5 line-clamp-3 text-[10px] leading-relaxed text-theme-400"
                >
                  {{ memory.content }}
                </p>
              </article>
              <template #content>
                <div
                  class="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-theme-200"
                  :aria-label="`Full memory content for ${memory.name}`"
                >
                  <div class="memory-title mb-1.5 font-semibold">
                    {{ memory.name }}
                  </div>
                  {{ memory.content }}
                </div>
              </template>
            </HoverTooltip>
          </div>

          <div
            v-if="card.channel === 'tools' && groupedAutoSelectedTools(card).length"
            class="mt-3 space-y-2"
            aria-label="Auto-selected MCPs, toolsets, and tools"
          >
            <section
              v-for="group in groupedAutoSelectedTools(card)"
              :key="group.id"
              class="toolset-card"
            >
              <div class="tool-title flex items-center gap-2 text-[11px] font-semibold">
                <Icon
                  icon="lucide:boxes"
                  class="h-3.5 w-3.5"
                />
                {{ group.label }}
              </div>
              <div
                v-if="group.tools.length"
                class="mt-2 flex flex-wrap gap-1.5"
              >
                <span
                  v-for="tool in group.tools"
                  :key="tool.name"
                  class="tool-chip"
                >
                  {{ tool.name }}<small v-if="tool.score">{{ tool.score }}</small>
                </span>
              </div>
              <p
                v-else
                class="mt-1 text-[10px] text-theme-500"
              >
                No individual tools selected.
              </p>
            </section>
          </div>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.pre-turn-card {
  --context-accent: var(--color-accent-400);
  --context-accent-soft: color-mix(in srgb, var(--color-accent-500) 8%, transparent);
  --context-accent-line: color-mix(in srgb, var(--color-theme-700) 65%, transparent);
  overflow: hidden;
  color: var(--color-theme-200);
  border: 1px solid var(--context-accent-line);
  border-radius: .75rem;
  background: color-mix(in srgb, var(--color-theme-800) 42%, transparent);
}

.pre-turn-card--memory {
  --context-accent: var(--color-accent-400);
}

.pre-turn-card--tools {
  --context-accent: var(--color-theme-300);
}

.card-icon {
  display: flex;
  height: 1.5rem;
  width: 1.5rem;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border-radius: .5rem;
  background: color-mix(in srgb, var(--color-theme-700) 48%, transparent);
  color: var(--context-accent);
}

.count-chip,
.score-chip {
  border-radius: .375rem;
  padding: .125rem .375rem;
  background: color-mix(in srgb, var(--color-theme-700) 42%, transparent);
  color: var(--color-theme-300);
  font-size: 10px;
  white-space: nowrap;
}

.collapsed-results {
  display: flex;
  flex-wrap: wrap;
  gap: .35rem;
  border-top: 1px solid color-mix(in srgb, var(--color-theme-700) 65%, transparent);
  padding: .5rem .7rem;
}

.collapsed-result-chip {
  display: inline-flex;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  gap: .35rem;
  border-radius: .4rem;
  border: 1px solid color-mix(in srgb, var(--color-theme-700) 70%, transparent);
  background: color-mix(in srgb, var(--color-theme-700) 32%, transparent);
  padding: .2rem .4rem;
  color: var(--color-theme-300);
  font-size: 10px;
}

.collapsed-result-chip small {
  flex-shrink: 0;
  color: var(--context-accent);
}

.memory-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: .5rem;
}

.memory-card {
  min-width: 0;
  border: 1px solid color-mix(in srgb, var(--color-theme-700) 58%, transparent);
  border-radius: .625rem;
  background: color-mix(in srgb, var(--color-theme-800) 52%, transparent);
  padding: .625rem;
}

.toolset-card {
  border: 1px solid color-mix(in srgb, var(--color-theme-700) 58%, transparent);
  border-radius: .625rem;
  background: color-mix(in srgb, var(--color-theme-800) 52%, transparent);
  padding: .625rem;
}

.tool-chip {
  border-radius: .4rem;
  border: 1px solid color-mix(in srgb, var(--color-theme-700) 58%, transparent);
  background: color-mix(in srgb, var(--color-theme-700) 32%, transparent);
  padding: .25rem .45rem;
  color: var(--color-theme-300);
  font-size: 10px;
}

.tool-chip small {
  margin-left: .35rem;
  color: color-mix(in srgb, var(--context-accent) 76%, var(--color-theme-400));
}

.context-score-text,
.memory-title {
  color: var(--context-accent, var(--color-accent-600));
}

.tool-title {
  color: var(--color-theme-300);
}

@media (max-width: 640px) {
  .memory-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
