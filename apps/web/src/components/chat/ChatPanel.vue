<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, reactive } from 'vue'
import { useChatStore, type DisplayMessage } from '../../stores/chat.store'
import { useAgentStore, type ExecutionStep } from '../../stores/agent-runtime.store'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import { wsConnected } from '../../api/http'
import MessageBubble from '../chat/MessageBubble.vue'
import ToolExecutionCard from '../chat/ToolExecutionCard.vue'
import ContextCompactCard from '../chat/ContextCompactCard.vue'
import HITLDialog from '../agent/HITLDialog.vue'
import CollapsibleSection from '../shared/CollapsibleSection.vue'
import { Icon } from '@iconify/vue'

const chatStore = useChatStore()
const agentStore = useAgentStore()
const agentDefs = useAgentDefinitionsStore()
const scrollContainer = ref<HTMLDivElement | null>(null)
const expandedFallback = ref<Set<string>>(new Set())
const collapsedSubAgentGroups = reactive(new Set<string>())
const fullHeightSubAgentGroups = reactive(new Set<string>())
const SCROLL_BOTTOM_THRESHOLD = 120

const activeAgentIconUrl = computed(() => {
  if (!chatStore.activeAgentId) return null
  return agentDefs.get(chatStore.activeAgentId)?.iconUrl ?? null
})

const activeAgentName = computed(() => {
  if (!chatStore.activeAgentId) return null
  return agentDefs.get(chatStore.activeAgentId)?.name ?? null
})

/** Resolve agent identity: prefer message's own data, then look up from agent
 *  definitions store by agentId, and only fall back to active agent last. */
function resolveAgentId(msg: DisplayMessage): string | undefined {
  return msg.agentId ?? chatStore.activeAgentId ?? undefined
}
function resolveAgentIconUrl(msg: DisplayMessage): string | null | undefined {
  if (msg.agentIconUrl !== undefined) return msg.agentIconUrl
  if (msg.agentId) return agentDefs.get(msg.agentId)?.iconUrl ?? null
  return activeAgentIconUrl.value
}
function resolveAgentName(msg: DisplayMessage): string | null | undefined {
  if (msg.agentName) return msg.agentName
  if (msg.agentId) return agentDefs.get(msg.agentId)?.name ?? null
  return activeAgentName.value
}

function isNearScrollBottom(el: HTMLElement, threshold = SCROLL_BOTTOM_THRESHOLD): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold
}

function scrollElementToBottom(el: HTMLElement): void {
  el.scrollTop = el.scrollHeight
}

function isMainNearBottom(): boolean {
  return scrollContainer.value ? isNearScrollBottom(scrollContainer.value) : true
}

function scrollMainToBottom(): void {
  nextTick(() => {
    if (scrollContainer.value) scrollElementToBottom(scrollContainer.value)
  })
}

function scrollMainToBottomIfNear(): void {
  if (!isMainNearBottom()) return
  scrollMainToBottom()
}

// ─── Post-action labels ─────────────────────────────────────

const postActionLabels: Record<string, string> = {
  'generating-title': 'Generating title…',
  'updating-entity-graph': 'Updating entity graph…'
}
function postActionLabel(action: string): string {
  return postActionLabels[action] || `${action}…`
}

const POST_ACTION_ORDER = ['generating-title', 'updating-entity-graph']
const activePostActionItems = computed(() =>
  Array.from(chatStore.activePostActions).sort((a, b) => {
    const ai = POST_ACTION_ORDER.indexOf(a)
    const bi = POST_ACTION_ORDER.indexOf(b)
    if (ai === -1 && bi === -1) return a.localeCompare(b)
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  }),
)

// ─── Unified timeline ───────────────────────────────────────

interface ToolGroup {
  iteration: number
  steps: ExecutionStep[]
  ts: number
}

type TimelineEntry =
  | { type: 'message'; msg: DisplayMessage; ts: number; key: string; isSubAgent?: boolean }
  | { type: 'tool-group'; group: ToolGroup; ts: number; key: string; isSubAgent?: boolean }
  | { type: 'tool-fallback'; msg: DisplayMessage; ts: number; key: string; isSubAgent?: boolean }
  | { type: 'compact-event'; msg: DisplayMessage; ts: number; key: string; isSubAgent?: false }
  | { type: 'sub-agent-group'; codename: string; agentName: string | null; agentId: string | null; entries: TimelineEntry[]; ts: number; key: string; isSubAgent?: false }

const unifiedTimeline = computed(() => {
  const entries: TimelineEntry[] = []
  const hasExecSteps = agentStore.executionSteps.length > 0
  const mainAgentId = chatStore.activeAgentId

  for (const msg of chatStore.messages) {
    // Compact event markers — rendered as divider cards, not regular messages
    if (msg.compactEventData) {
      entries.push({ type: 'compact-event', msg, ts: msg.createdAt, key: `ce-${msg.id}` })
      continue
    }
    // Skip plain system messages (agent prompts etc. are not shown to user)
    if (msg.role === 'system') continue
    // When we have execution steps, hide tool messages (shown via ToolExecutionCard)
    if (hasExecSteps && msg.role === 'tool') continue
    // Always hide empty assistant messages (tool-calling bookkeeping, no visible content)
    if (
      msg.role === 'assistant' &&
      !msg.content &&
      !msg.thinking &&
      !msg.imageDataUrls?.length &&
      !msg.isStreaming &&
      !msg.isError
    ) continue

    // A message is from a sub-agent if it has a different agentId than the orchestrator
    const isSubAgent = Boolean(msg.agentId && mainAgentId && msg.agentId !== mainAgentId)

    if (msg.role === 'tool') {
      // No exec steps available — render tool messages as compact fallback cards
      entries.push({ type: 'tool-fallback', msg, ts: msg.createdAt, key: `tf-${msg.id}`, isSubAgent })
    } else {
      entries.push({ type: 'message', msg, ts: msg.createdAt, key: `m-${msg.id}`, isSubAgent })
    }
  }

  if (hasExecSteps) {
    // Group steps by taskId + iteration to keep outer and inner executor steps separate
    const grouped = new Map<string, ExecutionStep[]>()
    for (const step of agentStore.executionSteps) {
      const groupKey = `${step.taskId || ''}-${step.iteration}`
      if (!grouped.has(groupKey)) grouped.set(groupKey, [])
      grouped.get(groupKey)!.push(step)
    }
    for (const [groupKey, steps] of grouped) {
      // A tool-group is from a sub-agent if any step has maCodename set
      const isSubAgent = steps.some(s => Boolean(s.maCodename))
      entries.push({
        type: 'tool-group',
        group: { iteration: steps[0].iteration, steps, ts: steps[0].timestamp },
        ts: steps[0].timestamp,
        key: `tg-${groupKey}`,
        isSubAgent
      })
    }
  }

  // Pure chronological sort. Streaming messages naturally have the latest
  // createdAt (set via Date.now() at stream-start/reset) so they already
  // sort last without special-casing. This ensures tool-group cards always
  // appear BELOW the agent message that triggered them.
  entries.sort((a, b) => a.ts - b.ts)

  // ── Group sub-agent entries by codename ─────────────────────────────────
  // Build a display-name → codename map from execution step metadata so we
  // can bucket sub-agent *messages* (which only carry agentName) together
  // with their corresponding tool-group cards.
  const agentNameToCodename = new Map<string, string>()
  for (const step of agentStore.executionSteps) {
    if (step.maCodename && step.maAgentName) {
      agentNameToCodename.set(step.maAgentName, step.maCodename)
    }
  }

  function codenameOf(entry: TimelineEntry): string | null {
    if (!entry.isSubAgent) return null
    if (entry.type === 'tool-group') return entry.group.steps[0]?.maCodename ?? null
    if (entry.type === 'message' && entry.msg.agentName) {
      return agentNameToCodename.get(entry.msg.agentName) ?? entry.msg.agentName
    }
    return null
  }

  // Collect consecutive runs of sub-agent entries and reorder them so all
  // entries sharing the same codename appear together (grouped by first seen).
  const result: TimelineEntry[] = []
  let subBatch: TimelineEntry[] = []

  const flushBatch = () => {
    if (!subBatch.length) return
    const byCodename = new Map<string, TimelineEntry[]>()
    const order: string[] = []
    for (const e of subBatch) {
      const key = codenameOf(e) ?? '__unknown__'
      if (!byCodename.has(key)) { byCodename.set(key, []); order.push(key) }
      byCodename.get(key)!.push(e)
    }
    for (const codename of order) {
      const innerEntries = byCodename.get(codename)!
      let agentName: string | null = null
      let agentId: string | null = null
      for (const e of innerEntries) {
        if (e.type === 'message' && e.msg.agentName) agentName = agentName ?? e.msg.agentName
        if (e.type === 'message' && e.msg.agentId) agentId = agentId ?? e.msg.agentId
        if (e.type === 'tool-group' && e.group.steps[0]?.maAgentName) agentName = agentName ?? e.group.steps[0].maAgentName
        if (agentName && agentId) break
      }
      result.push({
        type: 'sub-agent-group',
        codename,
        agentName,
        agentId,
        entries: innerEntries,
        ts: innerEntries[0].ts,
        key: `sag-${codename}-${innerEntries[0].ts}`
      })
    }
    subBatch = []
  }

  for (const entry of entries) {
    if (entry.isSubAgent) {
      subBatch.push(entry)
    } else {
      flushBatch()
      result.push(entry)
    }
  }
  flushBatch()

  return result
})

/** Key of the last tool-group entry — only this one can show as "active" */
const lastToolGroupKey = computed(() => {
  const groups = unifiedTimeline.value.filter(e => e.type === 'tool-group')
  return groups.length ? groups[groups.length - 1].key : null
})

/** Key of the sub-agent group currently being executed */
const activeSubAgentGroupKey = computed(() => {
  if (!agentStore.isExecuting) return null
  for (const entry of unifiedTimeline.value) {
    if (entry.type === 'sub-agent-group') {
      if (entry.entries.some(e => e.key === lastToolGroupKey.value)) return entry.key
    }
  }
  return null
})

function toggleSubAgentFullHeight(key: string): void {
  if (fullHeightSubAgentGroups.has(key)) {
    fullHeightSubAgentGroups.delete(key)
  } else {
    fullHeightSubAgentGroups.add(key)
  }
}

function toggleSubAgentCollapsed(key: string): void {
  if (collapsedSubAgentGroups.has(key)) {
    collapsedSubAgentGroups.delete(key)
  } else {
    collapsedSubAgentGroups.add(key)
    fullHeightSubAgentGroups.delete(key)
  }
}

function setFallbackExpanded(id: string, expanded: boolean): void {
  if (expanded) expandedFallback.value.add(id)
  else expandedFallback.value.delete(id)
}

// ─── Sub-agent box scroll ───────────────────────────────────

/** Map of sub-agent group key → its scrollable body element. */
const subAgentScrollRefs = new Map<string, HTMLElement>()
const initializedSubAgentScrolls = new Set<string>()

function collapseVisibleSubAgentGroups(): void {
  nextTick(() => {
    for (const entry of unifiedTimeline.value) {
      if (entry.type === 'sub-agent-group') collapsedSubAgentGroups.add(entry.key)
    }
  })
}

function registerSubAgentScroll(key: string, el: unknown): void {
  if (!(el instanceof HTMLElement)) {
    subAgentScrollRefs.delete(key)
    initializedSubAgentScrolls.delete(key)
    return
  }
  subAgentScrollRefs.set(key, el)
  if (initializedSubAgentScrolls.has(key)) return
  initializedSubAgentScrolls.add(key)
  nextTick(() => scrollElementToBottom(el))
}

function scrollSubAgentBoxesIfNear(): void {
  const boxesToScroll: HTMLElement[] = []
  const activeKeys = new Set<string>()
  for (const entry of unifiedTimeline.value) {
    if (entry.type !== 'sub-agent-group') continue
    activeKeys.add(entry.key)
    const el = subAgentScrollRefs.get(entry.key)
    if (el && isNearScrollBottom(el)) boxesToScroll.push(el)
  }
  for (const key of subAgentScrollRefs.keys()) {
    if (!activeKeys.has(key)) {
      subAgentScrollRefs.delete(key)
      initializedSubAgentScrolls.delete(key)
    }
  }
  nextTick(() => {
    for (const el of boxesToScroll) scrollElementToBottom(el)
  })
}

// Scroll triggers
watch(() => chatStore.messages.length, () => { scrollMainToBottomIfNear(); scrollSubAgentBoxesIfNear() })
watch(() => chatStore.messages[chatStore.messages.length - 1]?.content, () => { scrollMainToBottomIfNear(); scrollSubAgentBoxesIfNear() })
watch(() => chatStore.messages[chatStore.messages.length - 1]?.imageDataUrls?.length, () => { scrollMainToBottomIfNear(); scrollSubAgentBoxesIfNear() })
watch(() => agentStore.executionSteps.length, () => { scrollMainToBottomIfNear(); scrollSubAgentBoxesIfNear() })
watch(() => agentStore.pendingHITL, scrollMainToBottomIfNear)
// When loading finishes the spinner is replaced by rendered messages — scroll then
watch(() => chatStore.loadingMessages, (isLoading) => {
  if (isLoading) {
    collapsedSubAgentGroups.clear()
    fullHeightSubAgentGroups.clear()
    return
  }
  scrollMainToBottom()
  collapseVisibleSubAgentGroups()
})

// ─── Time-based greeting ────────────────────────────────────

const GREETINGS: Record<string, string[]> = {
  night:     ['Still up?', 'Burning the midnight oil?', 'Working late?'],
  morning:   ['Good morning.', 'Morning!', 'What are we building today?'],
  lunch:     ['Lunchtime.', 'Taking a lunch break?', 'Midday check-in.'],
  afternoon: ['Good afternoon.', 'Afternoon!', 'What\'s on your mind?'],
  evening:   ['Good evening.', 'Evening!', 'How can I help?'],
}

const greeting = computed(() => {
  const hour = new Date().getHours()
  const slot =
    hour < 5  ? 'night'     :
    hour < 12 ? 'morning'   :
    hour < 14 ? 'lunch'     :
    hour < 18 ? 'afternoon' : 'evening'
  const options = GREETINGS[slot]
  // Stable within the hour — rotates each new hour
  return options[hour % options.length]
})

// Scroll to bottom when mounting into an already-loaded conversation
// (e.g. navigating here from InstancesView after selectConversation was called)
onMounted(() => {
  scrollMainToBottom()
  collapseVisibleSubAgentGroups()
})
</script>

<template>
  <div
    ref="scrollContainer"
    class="flex-1 overflow-y-auto"
  >
    <!-- Loading spinner for long conversations -->
    <div
      v-if="chatStore.loadingMessages"
      class="flex flex-col items-center justify-center h-full"
    >
      <Icon
        icon="lucide:loader-2"
        class="w-8 h-8 text-theme-500 animate-spin"
      />
      <span class="text-sm text-theme-500 mt-3">Loading conversation…</span>
    </div>

    <!-- Empty state -->
    <div
      v-else-if="chatStore.messages.length === 0"
      class="flex flex-col items-center justify-center h-full text-theme-400"
    >
      <div class="relative flex items-center justify-center w-20 h-20 mb-6 bg-linear-to-br from-indigo-500/10 to-purple-500/10 rounded-3xl border border-white/5 shadow-xl">
        <Icon
          icon="lucide:bot-message-square"
          class="w-10 h-10 text-indigo-400"
        />
      </div>
      <template v-if="!wsConnected">
        <Icon
          icon="lucide:loader-2"
          class="w-8 h-8 text-theme-500 animate-spin mb-4"
        />
        <h2 class="text-xl font-semibold text-theme-200 tracking-tight">
          Initializing…
        </h2>
        <p class="text-sm mt-2 text-theme-500 max-w-sm text-center">
          Connecting to server and loading your data.
        </p>
      </template>
      <template v-else>
        <h2 class="text-xl font-semibold text-theme-200 tracking-tight">
          {{ greeting }}
        </h2>
        <p class="text-sm mt-2 text-theme-500 max-w-sm text-center">
          Type a message below to begin a new conversation, or choose an agent to assist you.
        </p>
      </template>
    </div>

    <!-- Unified timeline -->
    <div
      v-else
      class="max-w-4xl mx-auto py-4"
    >
      <template
        v-for="entry in unifiedTimeline"
        :key="entry.key"
      >
        <!-- Sub-agent group: collapsible box for a delegated sub-agent's activity -->
        <div
          v-if="entry.type === 'sub-agent-group'"
          class="mx-3 md:mx-4 my-2"
        >
          <div class="rounded-2xl border border-indigo-500/25 bg-indigo-950/10 overflow-hidden">
            <!-- Header -->
            <div class="w-full flex items-center gap-2.5 px-3 py-2.5">
              <!-- Sub-agent avatar -->
              <div class="w-6 h-6 rounded-full flex items-center justify-center shrink-0 overflow-hidden ring-1 ring-indigo-500/30 bg-theme-800">
                <img
                  v-if="entry.agentId && agentDefs.get(entry.agentId)?.iconUrl"
                  :src="agentDefs.get(entry.agentId)!.iconUrl!"
                  class="w-full h-full object-cover"
                  alt=""
                >
                <Icon
                  v-else
                  icon="lucide:bot"
                  class="w-3.5 h-3.5 text-indigo-400"
                />
              </div>
              <!-- Agent name + codename -->
              <div class="flex-1 min-w-0 flex items-baseline gap-1.5">
                <span class="text-[13px] font-medium text-indigo-300 truncate">{{ entry.agentName || entry.codename }}</span>
                <span
                  v-if="entry.agentName && entry.agentName !== entry.codename"
                  class="text-[10px] text-indigo-400/50 truncate shrink-0"
                >{{ entry.codename }}</span>
              </div>
              <!-- Running indicator -->
              <Icon
                v-if="activeSubAgentGroupKey === entry.key"
                icon="svg-spinners:ring-resize"
                class="w-3.5 h-3.5 text-indigo-400 shrink-0"
              />
              <!-- Step count badge -->
              <span class="text-[10px] text-indigo-400/50 tabular-nums shrink-0">
                {{ entry.entries.length }} step{{ entry.entries.length !== 1 ? 's' : '' }}
              </span>
              <button
                v-if="!collapsedSubAgentGroups.has(entry.key)"
                class="w-7 h-7 rounded-lg flex items-center justify-center text-indigo-400/50 hover:text-indigo-300 hover:bg-indigo-500/10 transition-colors shrink-0"
                :title="fullHeightSubAgentGroups.has(entry.key) ? 'Collapse to compact view' : 'Expand to full height'"
                @click="toggleSubAgentFullHeight(entry.key)"
              >
                <Icon
                  :icon="fullHeightSubAgentGroups.has(entry.key) ? 'lucide:minimize-2' : 'lucide:maximize-2'"
                  class="w-3.5 h-3.5"
                />
              </button>
              <!-- Height toggle icon -->
              <button
                class="w-7 h-7 rounded-lg flex items-center justify-center text-indigo-400/50 hover:text-indigo-300 hover:bg-indigo-500/10 transition-colors shrink-0"
                :title="collapsedSubAgentGroups.has(entry.key) ? 'Expand sub-agent steps' : 'Collapse sub-agent steps'"
                @click="toggleSubAgentCollapsed(entry.key)"
              >
                <Icon
                  :icon="collapsedSubAgentGroups.has(entry.key) ? 'lucide:chevron-down' : 'lucide:chevron-up'"
                  class="w-4 h-4"
                />
              </button>
            </div>
            <!-- Body: limited height by default, full height when toggled -->
            <div
              v-if="!collapsedSubAgentGroups.has(entry.key)"
              :ref="(el) => registerSubAgentScroll(entry.key, el)"
              class="border-t border-indigo-500/15 py-2 overflow-y-auto"
              :class="fullHeightSubAgentGroups.has(entry.key) ? '' : 'max-h-80'"
            >
              <template
                v-for="inner in entry.entries"
                :key="inner.key"
              >
                <MessageBubble
                  v-if="inner.type === 'message'"
                  :role="inner.msg.role"
                  :message-id="inner.msg.id"
                  :content="inner.msg.content"
                  :thinking="inner.msg.thinking"
                  :image-data-urls="inner.msg.imageDataUrls"
                  :audio-data-urls="inner.msg.audioDataUrls"
                  :file-attachments="inner.msg.fileAttachments"
                  :agent-id="resolveAgentId(inner.msg)"
                  :agent-icon-url="resolveAgentIconUrl(inner.msg)"
                  :agent-name="resolveAgentName(inner.msg)"
                  :model="inner.msg.model"
                  :prompt-tokens="inner.msg.promptTokens"
                  :completion-tokens="inner.msg.completionTokens"
                  :context-tokens="inner.msg.contextTokens"
                  :latency-ms="inner.msg.latencyMs"
                  :is-streaming="inner.msg.isStreaming"
                  :is-error="inner.msg.isError"
                  @retry="chatStore.retryFromMessage(inner.msg.id)"
                  @edit="(content) => chatStore.editMessage(inner.msg.id, content)"
                />
                <ToolExecutionCard
                  v-else-if="inner.type === 'tool-group'"
                  :iteration="inner.group.iteration"
                  :steps="inner.group.steps"
                  :is-active="agentStore.isExecuting && inner.key === lastToolGroupKey"
                />
                <div
                  v-else-if="inner.type === 'tool-fallback'"
                  class="px-4 py-1.5"
                >
                  <div class="max-w-[80%] ml-10">
                    <CollapsibleSection
                      :model-value="expandedFallback.has(inner.msg.id)"
                      :keyboard-shortcuts="true"
                      @update:model-value="setFallbackExpanded(inner.msg.id, $event)"
                    >
                      <template #trigger="{ expanded, toggle, triggerAttrs, onTriggerKeydown }">
                        <button
                          v-bind="triggerAttrs"
                          class="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs transition-colors group"
                          :class="expanded
                            ? 'bg-theme-800/80 border border-theme-700/60'
                            : 'bg-theme-800/40 hover:bg-theme-800/70 border border-theme-800/40 hover:border-theme-700/40'"
                          @click="toggle"
                          @keydown="onTriggerKeydown"
                        >
                          <Icon
                            icon="lucide:wrench"
                            class="w-3.5 h-3.5 text-theme-500 shrink-0"
                          />
                          <span class="text-theme-400 truncate flex-1 text-left">
                            {{ inner.msg.content.slice(0, 80) }}{{ inner.msg.content.length > 80 ? '…' : '' }}
                          </span>
                          <Icon
                            icon="lucide:chevron-down"
                            class="w-3 h-3 text-theme-600 shrink-0 transition-transform"
                            :class="{ 'rotate-180': expanded }"
                          />
                        </button>
                      </template>
                      <div class="mt-1.5 ml-3">
                        <pre class="text-[10px] text-theme-400 whitespace-pre-wrap break-all bg-theme-900/60 border border-theme-700/30 rounded-lg px-3 py-2 max-h-60 overflow-y-auto font-mono">{{ inner.msg.content }}</pre>
                      </div>
                    </CollapsibleSection>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </div>

        <!-- Regular message (user / assistant) -->
        <MessageBubble
          v-else-if="entry.type === 'message'"
          :role="entry.msg.role"
          :message-id="entry.msg.id"
          :content="entry.msg.content"
          :thinking="entry.msg.thinking"
          :image-data-urls="entry.msg.imageDataUrls"
          :audio-data-urls="entry.msg.audioDataUrls"
          :file-attachments="entry.msg.fileAttachments"
          :agent-id="resolveAgentId(entry.msg)"
          :agent-icon-url="resolveAgentIconUrl(entry.msg)"
          :agent-name="resolveAgentName(entry.msg)"
          :model="entry.msg.model"
          :prompt-tokens="entry.msg.promptTokens"
          :completion-tokens="entry.msg.completionTokens"
          :context-tokens="entry.msg.contextTokens"
          :latency-ms="entry.msg.latencyMs"
          :is-streaming="entry.msg.isStreaming"
          :is-error="entry.msg.isError"
          @retry="chatStore.retryFromMessage(entry.msg.id)"
          @edit="(content) => chatStore.editMessage(entry.msg.id, content)"
        />

        <!-- Tool execution group (from live execution steps) -->
        <ToolExecutionCard
          v-else-if="entry.type === 'tool-group'"
          :iteration="entry.group.iteration"
          :steps="entry.group.steps"
          :is-active="agentStore.isExecuting && entry.key === lastToolGroupKey"
        />

        <!-- Context compact event card -->
        <ContextCompactCard
          v-else-if="entry.type === 'compact-event' && entry.msg.compactEventData"
          :summary="entry.msg.compactEventData.summary"
          :compacted-message-count="entry.msg.compactEventData.compactedMessageCount"
          :model="entry.msg.compactEventData.model"
          :created-at="entry.msg.compactEventData.createdAt"
        />

        <!-- Fallback tool result (historical, no execution steps available) -->
        <div
          v-else-if="entry.type === 'tool-fallback'"
          class="px-4 py-1.5"
        >
          <div class="max-w-[80%] ml-10">
            <CollapsibleSection
              :model-value="expandedFallback.has(entry.msg.id)"
              :keyboard-shortcuts="true"
              @update:model-value="setFallbackExpanded(entry.msg.id, $event)"
            >
              <template #trigger="{ expanded, toggle, triggerAttrs, onTriggerKeydown }">
                <button
                  v-bind="triggerAttrs"
                  class="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs transition-colors group"
                  :class="expanded
                    ? 'bg-theme-800/80 border border-theme-700/60'
                    : 'bg-theme-800/40 hover:bg-theme-800/70 border border-theme-800/40 hover:border-theme-700/40'"
                  @click="toggle"
                  @keydown="onTriggerKeydown"
                >
                  <Icon
                    icon="lucide:wrench"
                    class="w-3.5 h-3.5 text-theme-500 shrink-0"
                  />
                  <span class="text-theme-400 truncate flex-1 text-left">
                    {{ entry.msg.content.slice(0, 80) }}{{ entry.msg.content.length > 80 ? '…' : '' }}
                  </span>
                  <Icon
                    icon="lucide:chevron-down"
                    class="w-3 h-3 text-theme-600 shrink-0 transition-transform"
                    :class="{ 'rotate-180': expanded }"
                  />
                </button>
              </template>
              <div class="mt-1.5 ml-3">
                <pre class="text-[10px] text-theme-400 whitespace-pre-wrap break-all bg-theme-900/60 border border-theme-700/30 rounded-lg px-3 py-2 max-h-60 overflow-y-auto font-mono">{{ entry.msg.content }}</pre>
              </div>
            </CollapsibleSection>
          </div>
        </div>
      </template>

      <!-- Working indicator (executing but not currently streaming) -->
      <div
        v-if="agentStore.isExecuting && !chatStore.isStreaming"
        class="px-4 py-2"
      >
        <div class="max-w-[80%] ml-10 flex items-center gap-2 text-xs text-theme-500">
          <Icon
            icon="svg-spinners:ring-resize"
            class="w-3.5 h-3.5 text-accent-400"
          />
          <span>Working…</span>
        </div>
      </div>

      <!-- Post-action indicators -->
      <div
        v-if="activePostActionItems.length > 0"
        class="px-4 py-1.5"
      >
        <div class="max-w-[80%] ml-10 rounded-lg border border-theme-800/70 bg-theme-950/70 px-3 py-2">
          <div class="flex items-center gap-2 text-xs text-theme-500">
            <Icon
              icon="svg-spinners:ring-resize"
              class="w-3.5 h-3.5 text-accent-400"
            />
            <span class="font-medium text-theme-400">Post-turn actions</span>
            <span class="text-theme-700">·</span>
            <span>{{ activePostActionItems.length }} running</span>
            <button
              class="ml-auto text-theme-600 hover:text-red-400 transition-colors"
              title="Cancel post-turn actions"
              @click="chatStore.cancelPostActions()"
            >
              <Icon
                icon="mdi:close-circle-outline"
                class="w-3.5 h-3.5"
              />
            </button>
          </div>
          <div class="mt-1.5 flex flex-wrap gap-1.5">
            <span
              v-for="action in activePostActionItems"
              :key="action"
              class="inline-flex items-center gap-1.5 rounded-md border border-theme-800 bg-theme-900/70 px-2 py-1 text-xs text-theme-400"
            >
              <Icon
                icon="lucide:loader-2"
                class="w-3 h-3 animate-spin text-theme-500"
              />
              {{ postActionLabel(action) }}
            </span>
          </div>
        </div>
      </div>

      <!-- HITL dialog -->
      <HITLDialog />
    </div>
  </div>
</template>
