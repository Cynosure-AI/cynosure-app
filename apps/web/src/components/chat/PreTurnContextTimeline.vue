<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { Icon } from '@iconify/vue'
import CollapsibleSection from '../shared/CollapsibleSection.vue'
import type { ToolExecStep } from './ToolExecutionCard.vue'

type ToolCall = NonNullable<ToolExecStep['toolCalls']>[number]
type ContextKind = 'toolsets' | 'tools' | 'memory' | 'entities' | 'attachments' | 'context'
type TimelineItem = {
  key: string
  label: string
  summary?: string
  icon: string
  tone: ContextKind
  timestamp: number
  details: Array<{ name: string; content?: string; score?: string; selected?: boolean }>
  pending: boolean
}

const props = defineProps<{
  steps: ToolExecStep[]
  isActive: boolean
}>()

const expanded = ref(false)
const expandedItems = reactive(new Set<string>())

const STATUS_LABELS: Record<string, { label: string; icon: string; tone: ContextKind }> = {
  'building-task-context': { label: 'Preparing search context', icon: 'lucide:compass', tone: 'context' },
  'indexing-attachments': { label: 'Indexing attachments', icon: 'lucide:paperclip', tone: 'attachments' },
  'indexing-tools': { label: 'Indexing tool definitions', icon: 'lucide:database-zap', tone: 'tools' },
  'routing-tools': { label: 'Gathering tools context', icon: 'lucide:route', tone: 'tools' },
  'finding-tools': { label: 'Finding required tools', icon: 'lucide:search-check', tone: 'tools' },
  'curating-tools': { label: 'AI selecting tools', icon: 'lucide:list-checks', tone: 'tools' },
  'routing-memory': { label: 'Querying memory', icon: 'lucide:brain-circuit', tone: 'memory' },
  'curating-memory': { label: 'AI selecting memory', icon: 'lucide:list-checks', tone: 'memory' },
}

function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.arguments || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function score(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const normalized = value > 1 ? value / 100 : value
  return `${Math.round(Math.max(0, Math.min(1, normalized)) * 100)}%`
}

function kindOf(call: ToolCall): ContextKind {
  const args = parseArgs(call)
  if (args.type === 'toolset-router') return 'toolsets'
  if (args.type === 'attachment-index') return 'attachments'
  if (args.type === 'memory') return args.memoryKind === 'knowledge' ? 'entities' : 'memory'
  if (args.type === 'tool-router') return 'tools'
  return 'context'
}

function phaseOf(calls: ToolCall[]): string {
  return text(parseArgs(calls[0]).contextPhase) || ''
}

function displayName(call: ToolCall): string {
  const args = parseArgs(call)
  if (args.type === 'memory') return text(args.sourceFile) || call.name
  if (call.name === 'Task context') return 'Search context'
  return call.name
}

function plural(count: number, singular: string, pluralValue = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralValue}`
}

function contextLabel(kind: ContextKind, phase: string, count: number): string {
  if (kind === 'toolsets') return `AI preselected ${plural(count, 'MCP/toolset', 'MCPs/toolsets')}`
  if (kind === 'tools') return phase === 'gathered-context'
    ? `AI selected ${plural(count, 'tool')}`
    : `Found ${plural(count, 'tool candidate')}`
  if (kind === 'memory') return phase === 'gathered-context'
    ? `AI selected ${plural(count, 'memory item')}`
    : `Found ${plural(count, 'memory match', 'memory matches')}`
  if (kind === 'entities') return phase === 'gathered-context'
    ? `AI selected ${plural(count, 'entity relationship')}`
    : `Found ${plural(count, 'entity relationship')}`
  if (kind === 'attachments') return `Indexed ${plural(count, 'attachment')}`
  return 'Prepared search context'
}

function callDetails(calls: ToolCall[], selected?: boolean): TimelineItem['details'] {
  return calls.map((call) => {
    const args = parseArgs(call)
    return {
      name: displayName(call),
      content: text(args.content) || text(args.toolQuery) || text(args.memoryQuery),
      score: score(args.routerScore ?? args.rerankerScore ?? args.matchScore),
      selected,
    }
  })
}

const items = computed<TimelineItem[]>(() => {
  const result: TimelineItem[] = []
  props.steps.forEach((step, stepIndex) => {
    const calls = step.toolCalls || []
    const taskCalls = calls.filter((call) => ['task-context', 'auto-router'].includes(String(parseArgs(call).type)))
    if (taskCalls.length) {
      const args = parseArgs(taskCalls[0])
      const details = [
        text(args.toolQuery) ? { name: 'Tools query', content: text(args.toolQuery) } : null,
        text(args.memoryQuery) ? { name: 'Memory query', content: text(args.memoryQuery) } : null,
        !text(args.toolQuery) && !text(args.memoryQuery) && text(args.content)
          ? { name: 'Context', content: text(args.content) }
          : null,
      ].filter((value): value is NonNullable<typeof value> => Boolean(value))
      result.push({ key: `${stepIndex}-task`, label: 'Prepared search context', icon: 'lucide:compass', tone: 'context', timestamp: step.timestamp, details, pending: false })
    }

    const contextCalls = calls.filter((call) => ['toolset-router', 'tool-router', 'memory', 'attachment-index'].includes(String(parseArgs(call).type)))
    const groups = new Map<ContextKind, ToolCall[]>()
    contextCalls.forEach((call) => groups.set(kindOf(call), [...(groups.get(kindOf(call)) || []), call]))
    for (const [kind, groupedCalls] of groups) {
      const phase = phaseOf(groupedCalls)
      result.push({
        key: `${stepIndex}-${kind}-${phase}`,
        label: contextLabel(kind, phase, groupedCalls.length),
        summary: phase === 'gathered-context' ? 'Selected for this turn' : undefined,
        icon: kind === 'toolsets' ? 'lucide:boxes' : phase === 'gathered-context' ? 'lucide:check' : kind === 'memory' ? 'lucide:brain' : kind === 'entities' ? 'lucide:network' : 'lucide:package-search',
        tone: kind,
        timestamp: step.timestamp,
        details: callDetails(groupedCalls, kind === 'toolsets' || phase === 'gathered-context'),
        pending: false,
      })
    }

    if (!taskCalls.length && !contextCalls.length) {
      const meta = STATUS_LABELS[step.status]
      if (meta) result.push({
        key: `${stepIndex}-${step.status}`,
        label: meta.label,
        summary: step.message,
        icon: meta.icon,
        tone: meta.tone,
        timestamp: step.timestamp,
        details: step.streamingChoosing ? [{ name: 'Model routing', content: step.streamingChoosing }] : [],
        pending: props.isActive && stepIndex === props.steps.length - 1,
      })
    }
  })
  return result
})

const selectedTools = computed(() => uniqueSelected('tools'))
const selectedToolsets = computed(() => uniqueSelected('toolsets').length)
const selectedMemory = computed(() => uniqueSelected('memory').length)
const selectedEntities = computed(() => uniqueSelected('entities').length)
const isPending = computed(() => props.isActive && items.value.some((item) => item.pending))

function uniqueSelected(kind: ContextKind): string[] {
  return [...new Set(items.value
    .filter((item) => item.tone === kind && item.details.some((detail) => detail.selected))
    .flatMap((item) => item.details.filter((detail) => detail.selected).map((detail) => detail.name)))]
}

function toggleItem(key: string): void {
  if (expandedItems.has(key)) expandedItems.delete(key)
  else expandedItems.add(key)
}

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(timestamp)
}
</script>

<template>
  <div v-if="items.length" class="px-4 py-2">
    <div class="ml-3 max-w-[80%] md:ml-12">
      <CollapsibleSection v-model="expanded">
        <template #trigger="{ expanded: isExpanded, toggle, triggerAttrs }">
          <button
            v-bind="triggerAttrs"
            class="context-header group flex w-full items-center gap-2 rounded-2xl px-3.5 py-2.5 text-left transition-all"
            :class="{ '!rounded-b-none': isExpanded }"
            @click="toggle"
          >
            <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-cyan-400/10 ring-1 ring-cyan-300/15">
              <Icon :icon="isPending ? 'svg-spinners:ring-resize' : 'lucide:history'" class="h-3.5 w-3.5 text-cyan-300" />
            </span>
            <span class="text-[12px] font-semibold text-cyan-100">Pre-turn context</span>
            <span v-if="selectedTools.length" class="context-chip">{{ plural(selectedTools.length, 'tool') }}</span>
            <span v-if="selectedToolsets" class="context-chip">{{ plural(selectedToolsets, 'toolset') }}</span>
            <span v-if="selectedMemory" class="context-chip">{{ plural(selectedMemory, 'memory item') }}</span>
            <span v-if="selectedEntities" class="context-chip">{{ plural(selectedEntities, 'relationship') }}</span>
            <span class="ml-auto text-[10px] text-theme-500">{{ items.length }} steps</span>
            <Icon icon="lucide:chevron-down" class="h-3 w-3 text-theme-500 transition-transform" :class="{ 'rotate-180': isExpanded }" />
          </button>
        </template>

        <ol class="context-timeline rounded-b-2xl py-2.5">
          <li v-for="item in items" :key="item.key" class="timeline-item" :class="`timeline-item--${item.tone}`">
            <button
              class="flex w-full min-w-0 items-start gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-theme-800/35"
              :class="{ 'cursor-default': !item.details.length }"
              :aria-expanded="item.details.length ? expandedItems.has(item.key) : undefined"
              @click="item.details.length && toggleItem(item.key)"
            >
              <Icon :icon="item.pending ? 'svg-spinners:ring-resize' : item.icon" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-400" />
              <span class="min-w-0 flex-1">
                <span class="block text-[11px] font-medium text-theme-300">{{ item.label }}</span>
                <span v-if="item.summary" class="block truncate text-[10px] text-theme-500">{{ item.summary }}</span>
              </span>
              <time class="text-[10px] tabular-nums text-theme-600">{{ formatTimestamp(item.timestamp) }}</time>
              <Icon v-if="item.details.length" icon="lucide:chevron-right" class="mt-0.5 h-3 w-3 text-theme-600 transition-transform" :class="{ 'rotate-90': expandedItems.has(item.key) }" />
            </button>

            <div v-if="item.details.length && expandedItems.has(item.key)" class="mb-1 ml-8 mr-2 space-y-1 rounded-lg bg-theme-950/40 p-2">
              <div v-for="(detail, index) in item.details" :key="`${detail.name}-${index}`" class="text-[10px]">
                <div class="flex items-center gap-2">
                  <span class="font-medium text-theme-400">{{ detail.name }}</span>
                  <span v-if="detail.score" class="rounded bg-cyan-500/10 px-1.5 py-0.5 text-cyan-300">{{ detail.score }}</span>
                </div>
                <pre v-if="detail.content" class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap wrap-break-word font-sans leading-relaxed text-theme-500">{{ detail.content }}</pre>
              </div>
            </div>
          </li>
        </ol>
      </CollapsibleSection>
    </div>
  </div>
</template>

<style scoped>
.context-header {
  border: 1px solid rgb(34 211 238 / .2);
  background:
    radial-gradient(circle at 0 50%, rgb(34 211 238 / .11), transparent 30%),
    linear-gradient(135deg, rgb(15 23 42 / .88), rgb(8 47 73 / .32));
  box-shadow: inset 0 1px 0 rgb(255 255 255 / .025), 0 8px 24px rgb(0 0 0 / .12);
}
.context-header:hover { border-color: rgb(34 211 238 / .36); filter: brightness(1.06); }
.context-chip { border-radius: .375rem; padding: .125rem .375rem; background: rgb(6 182 212 / .1); color: rgb(165 243 252); font-size: 10px; }
.context-timeline {
  position: relative;
  padding-left: 2.25rem;
  border: 1px solid rgb(34 211 238 / .16);
  border-top: 0;
  background:
    radial-gradient(circle at 8% 0, rgb(34 211 238 / .08), transparent 34%),
    linear-gradient(180deg, rgb(15 23 42 / .72), rgb(9 14 25 / .82));
  box-shadow: inset 0 1px 0 rgb(255 255 255 / .02), 0 12px 30px rgb(0 0 0 / .12);
}
.context-timeline::before { content: ''; position: absolute; left: 1.28rem; top: 1.15rem; bottom: 1.15rem; width: 1px; background: color-mix(in srgb, var(--color-cyan-400) 42%, transparent); }
.timeline-item { position: relative; }
.timeline-item::before { content: ''; position: absolute; z-index: 1; left: -1.25rem; top: 1rem; width: .48rem; height: .48rem; border: 2px solid var(--color-theme-900); border-radius: 9999px; background: rgb(34 211 238); box-shadow: 0 0 0 2px rgb(34 211 238 / .18); }
.timeline-item--memory::before { background: rgb(167 139 250); }
.timeline-item--toolsets::before { background: rgb(45 212 191); }
.timeline-item--entities::before { background: rgb(129 140 248); }
.timeline-item--attachments::before { background: rgb(56 189 248); }
</style>
