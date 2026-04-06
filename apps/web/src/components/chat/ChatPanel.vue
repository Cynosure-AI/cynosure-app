<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'
import { useChatStore, type DisplayMessage } from '../../stores/chat.store'
import { useAgentStore, type ExecutionStep } from '../../stores/agent.store'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import MessageBubble from '../chat/MessageBubble.vue'
import ToolExecutionCard from '../chat/ToolExecutionCard.vue'
import HITLDialog from '../agent/HITLDialog.vue'
import { Icon } from '@iconify/vue'

const chatStore = useChatStore()
const agentStore = useAgentStore()
const agentDefs = useAgentDefinitionsStore()
const scrollContainer = ref<HTMLDivElement | null>(null)
const expandedFallback = ref<Set<string>>(new Set())

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

function isNearBottom(): boolean {
  if (!scrollContainer.value) return true
  const { scrollTop, scrollHeight, clientHeight } = scrollContainer.value
  return scrollHeight - scrollTop - clientHeight < 150
}

function scrollToBottom(): void {
  nextTick(() => {
    if (scrollContainer.value) {
      scrollContainer.value.scrollTop = scrollContainer.value.scrollHeight
    }
  })
}

function scrollToBottomIfNear(): void {
  if (!isNearBottom()) return
  scrollToBottom()
}

// ─── Post-action labels ─────────────────────────────────────

const postActionLabels: Record<string, string> = {
  'generating-title': 'Generating title…'
}
function postActionLabel(action: string): string {
  return postActionLabels[action] || `${action}…`
}

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

const unifiedTimeline = computed(() => {
  const entries: TimelineEntry[] = []
  const hasExecSteps = agentStore.executionSteps.length > 0
  const mainAgentId = chatStore.activeAgentId

  for (const msg of chatStore.messages) {
    // When we have execution steps, hide tool messages (shown via ToolExecutionCard)
    if (hasExecSteps && msg.role === 'tool') continue
    // Always hide empty assistant messages (tool-calling bookkeeping, no visible content)
    if (msg.role === 'assistant' && !msg.content && !msg.thinking && !msg.isStreaming && !msg.isError) continue

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

  entries.sort((a, b) => {
    // The currently-streaming message always sorts last so tool-group cards
    // appear before it, not after it.
    const aIsStreaming = a.type === 'message' && a.msg.isStreaming
    const bIsStreaming = b.type === 'message' && b.msg.isStreaming
    if (aIsStreaming && !bIsStreaming) return 1
    if (!aIsStreaming && bIsStreaming) return -1
    return a.ts - b.ts
  })

  // Post-sort structural correction: execution step groups must precede the
  // assistant response they lead into, regardless of timestamp clock skew
  // (server-saved DB timestamps vs. frontend WebSocket-arrival timestamps).
  if (hasExecSteps) {
    let lastAssistantIdx = -1
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if (e.type === 'message' && e.msg.role === 'assistant') {
        lastAssistantIdx = i
        break
      }
    }
    if (lastAssistantIdx >= 0) {
      const displaced: TimelineEntry[] = []
      const kept: TimelineEntry[] = []
      for (let i = 0; i < entries.length; i++) {
        if (i > lastAssistantIdx && entries[i].type === 'tool-group') {
          displaced.push(entries[i])
        } else {
          kept.push(entries[i])
        }
      }
      if (displaced.length > 0) {
        let insertAt = -1
        for (let i = kept.length - 1; i >= 0; i--) {
          const e = kept[i]
          if (e.type === 'message' && e.msg.role === 'assistant') {
            insertAt = i
            break
          }
        }
        if (insertAt >= 0) kept.splice(insertAt, 0, ...displaced)
        return kept
      }
    }
  }

  return entries
})

/** Key of the last tool-group entry — only this one can show as "active" */
const lastToolGroupKey = computed(() => {
  const groups = unifiedTimeline.value.filter(e => e.type === 'tool-group')
  return groups.length ? groups[groups.length - 1].key : null
})

function toggleFallback(id: string): void {
  if (expandedFallback.value.has(id)) {
    expandedFallback.value.delete(id)
  } else {
    expandedFallback.value.add(id)
  }
}

// Scroll triggers
watch(() => chatStore.messages.length, scrollToBottom)
watch(() => chatStore.messages[chatStore.messages.length - 1]?.content, scrollToBottomIfNear)
watch(() => agentStore.executionSteps.length, scrollToBottomIfNear)
watch(() => agentStore.pendingHITL, scrollToBottomIfNear)
</script>

<template>
  <div
    ref="scrollContainer"
    class="flex-1 overflow-y-auto"
  >
    <!-- Empty state -->
    <div
      v-if="chatStore.messages.length === 0"
      class="flex flex-col items-center justify-center h-full text-zinc-400"
    >
      <div class="relative flex items-center justify-center w-20 h-20 mb-6 bg-linear-to-br from-indigo-500/10 to-purple-500/10 rounded-3xl border border-white/5 shadow-xl">
        <Icon
          icon="lucide:bot-message-square"
          class="w-10 h-10 text-indigo-400"
        />
      </div>
      <h2 class="text-xl font-semibold text-zinc-200 tracking-tight">
        How can I help you today?
      </h2>
      <p class="text-sm mt-2 text-zinc-500 max-w-sm text-center">
        Type a message below to begin a new conversation, or choose an agent to assist you.
      </p>
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
        <!-- Sub-agent wrapper: indented with left border to show nesting -->
        <div
          v-if="entry.isSubAgent"
          class="ml-6 pl-3 border-l-2 border-indigo-500/20"
        >
          <MessageBubble
            v-if="entry.type === 'message'"
            :role="entry.msg.role"
            :message-id="entry.msg.id"
            :content="entry.msg.content"
            :thinking="entry.msg.thinking"
            :image-data-urls="entry.msg.imageDataUrls"
            :audio-data-urls="entry.msg.audioDataUrls"
            :memory-sources="entry.msg.memorySources"
            :agent-id="resolveAgentId(entry.msg)"
            :agent-icon-url="resolveAgentIconUrl(entry.msg)"
            :agent-name="resolveAgentName(entry.msg)"
            :model="entry.msg.model"
            :prompt-tokens="entry.msg.promptTokens"
            :completion-tokens="entry.msg.completionTokens"
            :latency-ms="entry.msg.latencyMs"
            :is-streaming="entry.msg.isStreaming"
            :is-error="entry.msg.isError"
            @retry="chatStore.retryFromMessage(entry.msg.id)"
            @edit="(content) => chatStore.editMessage(entry.msg.id, content)"
          />
          <ToolExecutionCard
            v-else-if="entry.type === 'tool-group'"
            :iteration="entry.group.iteration"
            :steps="entry.group.steps"
            :is-active="agentStore.isExecuting && entry.key === lastToolGroupKey"
          />
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
          :memory-sources="entry.msg.memorySources"
          :agent-id="resolveAgentId(entry.msg)"
          :agent-icon-url="resolveAgentIconUrl(entry.msg)"
          :agent-name="resolveAgentName(entry.msg)"
          :model="entry.msg.model"
          :prompt-tokens="entry.msg.promptTokens"
          :completion-tokens="entry.msg.completionTokens"
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

        <!-- Fallback tool result (historical, no execution steps available) -->
        <div
          v-else-if="entry.type === 'tool-fallback'"
          class="px-4 py-1.5"
        >
          <div class="max-w-[80%] ml-10">
            <button
              class="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs transition-colors group"
              :class="expandedFallback.has(entry.msg.id)
                ? 'bg-zinc-800/80 border border-zinc-700/60'
                : 'bg-zinc-800/40 hover:bg-zinc-800/70 border border-zinc-800/40 hover:border-zinc-700/40'"
              @click="toggleFallback(entry.msg.id)"
            >
              <Icon
                icon="lucide:wrench"
                class="w-3.5 h-3.5 text-zinc-500 shrink-0"
              />
              <span class="text-zinc-400 truncate flex-1 text-left">
                {{ entry.msg.content.slice(0, 80) }}{{ entry.msg.content.length > 80 ? '…' : '' }}
              </span>
              <Icon
                icon="lucide:chevron-down"
                class="w-3 h-3 text-zinc-600 shrink-0 transition-transform"
                :class="{ 'rotate-180': expandedFallback.has(entry.msg.id) }"
              />
            </button>
            <div
              v-if="expandedFallback.has(entry.msg.id)"
              class="mt-1.5 ml-3"
            >
              <pre class="text-[10px] text-zinc-400 whitespace-pre-wrap break-all bg-zinc-900/60 border border-zinc-700/30 rounded-lg px-3 py-2 max-h-60 overflow-y-auto font-mono">{{ entry.msg.content }}</pre>
            </div>
          </div>
        </div>
      </template>

      <!-- Working indicator (executing but not currently streaming) -->
      <div
        v-if="agentStore.isExecuting && !chatStore.isStreaming"
        class="px-4 py-2"
      >
        <div class="max-w-[80%] ml-10 flex items-center gap-2 text-xs text-zinc-500">
          <Icon
            icon="svg-spinners:ring-resize"
            class="w-3.5 h-3.5 text-blue-400"
          />
          <span>Working…</span>
        </div>
      </div>

      <!-- Post-action indicators (title generation, report creation) -->
      <div
        v-if="chatStore.activePostActions.size > 0"
        class="px-4 py-1.5"
      >
        <div
          v-for="action in chatStore.activePostActions"
          :key="action"
          class="max-w-[80%] ml-10 flex items-center gap-2 text-xs text-zinc-500 py-0.5"
        >
          <Icon
            icon="svg-spinners:ring-resize"
            class="w-3 h-3 text-zinc-500"
          />
          <span>{{ postActionLabel(action) }}</span>
          <button
            class="ml-1 text-zinc-600 hover:text-red-400 transition-colors"
            title="Cancel"
            @click="chatStore.cancelPostActions()"
          >
            <Icon
              icon="mdi:close-circle-outline"
              class="w-3.5 h-3.5"
            />
          </button>
        </div>
      </div>

      <!-- HITL dialog -->
      <HITLDialog />
    </div>
  </div>
</template>
