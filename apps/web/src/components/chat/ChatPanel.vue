<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, reactive } from 'vue'
import { useChatStore, type DisplayMessage } from '../../stores/chat.store'
import { useAgentStore } from '../../stores/agent-runtime.store'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import { useAgentHealthStore } from '../../stores/agent-health.store'
import { usePreferencesStore } from '../../stores/preferences.store'
import { wsConnected } from '../../api/http'
import MessageBubble from '../chat/MessageBubble.vue'
import ToolExecutionCard from '../chat/ToolExecutionCard.vue'
import PreTurnContextTimeline from '../chat/PreTurnContextTimeline.vue'
import ChatActivityIndicator from '../chat/ChatActivityIndicator.vue'
import QuickResponses from '../chat/QuickResponses.vue'
import ContextCompactCard from '../chat/ContextCompactCard.vue'
import ContinuationRoundMarker from '../chat/ContinuationRoundMarker.vue'
import HITLDialog from '../agent/HITLDialog.vue'
import ToolExecutionList from './ToolExecutionList.vue'
import ArtifactImageModal from '../shared/ArtifactImageModal.vue'
import { useToolPresentation } from '../../composables/useToolPresentation'
import RichContent from '../shared/RichContent.vue'
import { Icon } from '@iconify/vue'
import { useRoute } from 'vue-router'
import { buildChatTimeline, type TimelineEntry } from '../../utils/chat-timeline'
import { fileArtifactLinks, type FileArtifactLink } from '../../utils/file-artifacts'

const props = withDefaults(defineProps<{
  searchOpen?: boolean
}>(), {
  searchOpen: false,
})

const emit = defineEmits<{ closeSearch: []; selectQuickResponse: [suggestion: string] }>()

const chatStore = useChatStore()
const route = useRoute()
const agentStore = useAgentStore()
const agentDefs = useAgentDefinitionsStore()
const prefs = usePreferencesStore()
const agentHealth = useAgentHealthStore()
const forkError = ref('')
async function forkMessage(messageId: string): Promise<void> {
  forkError.value = ''
  try {
    await chatStore.forkConversationFromMessage(messageId)
  } catch (error) {
    forkError.value = `Could not fork conversation: ${error instanceof Error ? error.message : String(error)}`
  }
}

const scrollContainer = ref<HTMLDivElement | null>(null)
const toolPresentation = useToolPresentation()
const lightboxSrc = ref<string | null>(null)
const collapsedSubAgentGroups = reactive(new Set<string>())
const fullHeightSubAgentGroups = reactive(new Set<string>())
const searchInput = ref<HTMLInputElement | null>(null)
const searchQuery = ref('')
const currentSearchResultIndex = ref(-1)
const SCROLL_BOTTOM_THRESHOLD = 72

const searchResults = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase()
  if (!props.searchOpen || !query) return []

  return chatStore.messages
    .filter(message =>
      message.role !== 'system'
      && message.role !== 'tool'
      && message.content.toLocaleLowerCase().includes(query)
    )
    .map(message => message.id)
})

const activeSearchMessageId = computed(
  () => searchResults.value[currentSearchResultIndex.value] ?? null
)

const searchResultLabel = computed(() => {
  if (!searchQuery.value.trim()) return 'Type to search'
  if (!searchResults.value.length) return 'No results'
  return `${currentSearchResultIndex.value + 1} of ${searchResults.value.length}`
})

function findSearchMessageElement(messageId: string): HTMLElement | null {
  const elements = scrollContainer.value?.querySelectorAll<HTMLElement>('[data-chat-search-message-id]')
  if (!elements) return null
  return Array.from(elements).find(
    element => element.dataset.chatSearchMessageId === messageId
  ) ?? null
}

function expandSearchResultContainer(messageId: string): void {
  for (const entry of unifiedTimeline.value) {
    if (
      entry.type === 'sub-agent-group'
      && entry.entries.some(inner => inner.type === 'message' && inner.msg.id === messageId)
    ) {
      collapsedSubAgentGroups.delete(entry.key)
      return
    }
  }
}

function scrollToSearchResult(messageId: string): void {
  expandSearchResultContainer(messageId)
  nextTick(() => {
    findSearchMessageElement(messageId)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    })
  })
}

function moveSearchResult(direction: 1 | -1): void {
  const count = searchResults.value.length
  if (!count) return
  currentSearchResultIndex.value = (
    currentSearchResultIndex.value + direction + count
  ) % count
}

function closeSearch(): void {
  emit('closeSearch')
}

watch(() => props.searchOpen, (open) => {
  if (!open) {
    searchQuery.value = ''
    currentSearchResultIndex.value = -1
    return
  }
  nextTick(() => {
    searchInput.value?.focus()
    searchInput.value?.select()
  })
}, { immediate: true })

watch(searchResults, (results, previousResults) => {
  const previousMessageId = previousResults[currentSearchResultIndex.value]
  const preservedIndex = previousMessageId ? results.indexOf(previousMessageId) : -1
  currentSearchResultIndex.value = preservedIndex >= 0
    ? preservedIndex
    : results.length ? 0 : -1
})

watch(activeSearchMessageId, (messageId) => {
  if (messageId) scrollToSearchResult(messageId)
})

const conversationAgentId = computed(() => {
  if (!chatStore.activeConversationId) return chatStore.activeAgentId
  const conversation = chatStore.conversations.find(
    candidate => candidate.id === chatStore.activeConversationId
  )
  if (conversation) return conversation.agentId ?? null
  return chatStore.activeAgentId
})

const activeAgentIssues = computed(() => conversationAgentId.value
  ? agentHealth.healthByAgent.get(conversationAgentId.value)?.issues ?? []
  : [])

const activeAgentIconUrl = computed(() => {
  if (!conversationAgentId.value) return null
  return agentDefs.get(conversationAgentId.value)?.iconUrl ?? null
})

const activeAgentName = computed(() => {
  if (!conversationAgentId.value) return null
  return agentDefs.get(conversationAgentId.value)?.name ?? null
})

const emptyStateSubAgents = computed(() => {
  return chatStore.freeChatSubAgentIds
    .map((id) => agentDefs.get(id))
    .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent))
})
const visibleEmptyStateSubAgents = computed(() =>
  emptyStateSubAgents.value.length > 8
    ? emptyStateSubAgents.value.slice(0, 7)
    : emptyStateSubAgents.value,
)
const overflowEmptyStateSubAgents = computed(() =>
  emptyStateSubAgents.value.slice(visibleEmptyStateSubAgents.value.length),
)
const overflowEmptyStateSubAgentsTitle = computed(() =>
  overflowEmptyStateSubAgents.value.map((agent) => agent.name).join('\n'),
)

/** Resolve agent identity: prefer message's own data, then look up from agent
 *  definitions store by agentId, and only fall back to the conversation agent. */
function resolveAgentId(msg: DisplayMessage): string | undefined {
  return msg.agentId ?? conversationAgentId.value ?? undefined
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

const generatingTitle = computed(() => chatStore.activePostActions.has('generating-title'))
const generatingQuickResponses = computed(() =>
  prefs.quickResponses
    && !agentStore.isExecuting
    && chatStore.activePostActions.has('generating-quick-responses'),
)
const visibleQuickResponses = computed(() => prefs.quickResponses ? chatStore.activeQuickResponses : [])

// ─── Unified timeline ───────────────────────────────────────

const unifiedTimeline = computed(() => buildChatTimeline(
  chatStore.messages, agentStore.executionSteps,
))

/** Key of the last tool-group entry — only this one can show as "active" */
const lastToolGroupKey = computed(() => {
  const groups = unifiedTimeline.value.flatMap((entry) => {
    if (entry.type === 'tool-group') return [entry]
    if (entry.type === 'sub-agent-group') return entry.entries.filter(e => e.type === 'tool-group')
    return []
  })
  return groups.reduce<(typeof groups)[number] | null>((latest, group) =>
    !latest || group.ts >= latest.ts ? group : latest, null)?.key ?? null
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

function delegationResultLabel(results: Extract<TimelineEntry, { type: 'delegation-result' }>['results']): string {
  if (results.some(result => result.success === false && (result.name === 'spawn_subagent' || result.name === 'continue_subagent'))) {
    return 'Delegation failed'
  }
  if (results.some(result => result.success === false)) return 'Sub-agent returned · tool error'
  if (results.some(result => result.success === undefined)) return 'Sub-agent returned · outcome unavailable'
  return 'Sub-agent returned'
}

function toggleSubAgentFullHeight(key: string): void {
  if (fullHeightSubAgentGroups.has(key)) {
    fullHeightSubAgentGroups.delete(key)
  } else {
    fullHeightSubAgentGroups.add(key)
  }
}

function collectFileArtifactsFromText(text: string, seen: Set<string>, artifacts: FileArtifactLink[]): void {
  for (const artifact of fileArtifactLinks(text)) {
    if (seen.has(artifact.href)) continue
    seen.add(artifact.href)
    artifacts.push(artifact)
  }
}

function hasLaterToolGroupInTurn(entries: TimelineEntry[], index: number): boolean {
  for (let i = index + 1; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.type === 'message' && entry.msg.role === 'user') return false
    if (entry.type === 'tool-group') return true
  }
  return false
}

function assistantFileArtifacts(entry: TimelineEntry, entries = unifiedTimeline.value): FileArtifactLink[] {
  if (entry.type !== 'message' || entry.msg.role !== 'assistant' || entry.msg.isStreaming) return []
  const index = entries.findIndex((candidate) => candidate.key === entry.key)
  if (index === -1 || hasLaterToolGroupInTurn(entries, index)) return []

  const artifacts: FileArtifactLink[] = []
  const seen = new Set<string>()

  for (let i = index - 1; i >= 0; i--) {
    const previous = entries[i]
    if (previous.type === 'message' && previous.msg.role === 'user') break
    if (previous.type !== 'tool-group') continue
    for (const step of previous.group.steps) {
      for (const result of step.results || []) {
        collectFileArtifactsFromText(result.output || '', seen, artifacts)
      }
    }
  }

  collectFileArtifactsFromText(entry.msg.content, seen, artifacts)
  return artifacts.reverse()
}

/** Keep main and delegated messages consistent, including their artifact timeline. */
function messageBubbleProps(entry: Extract<TimelineEntry, { type: 'message' }>, entries = unifiedTimeline.value) {
  const { msg } = entry
  return {
    role: msg.role,
    messageId: msg.id,
    forkDisabled: chatStore.isConversationLocked,
    createdAt: msg.createdAt,
    content: msg.content,
    thinking: msg.thinking,
    imageDataUrls: msg.imageDataUrls,
    videoDataUrls: msg.videoDataUrls,
    audioDataUrls: msg.audioDataUrls,
    fileAttachments: msg.fileAttachments,
    fileArtifacts: assistantFileArtifacts(entry, entries),
    agentId: resolveAgentId(msg),
    agentIconUrl: resolveAgentIconUrl(msg),
    agentName: resolveAgentName(msg),
    model: msg.model,
    promptTokens: msg.promptTokens,
    completionTokens: msg.completionTokens,
    contextTokens: msg.contextTokens,
    latencyMs: msg.latencyMs,
    isStreaming: msg.isStreaming,
    isError: msg.isError,
    stopped: msg.stopped,
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

function savedToolRows(entry: Extract<TimelineEntry, { type: 'saved-tool-result' }>) {
  const { msg, call } = entry
  const name = call?.name ?? 'Tool result'
  return [{
    call,
    name: toolPresentation.toolDisplayName(name),
    icon: toolPresentation.toolNamespaceIcon(name),
    iconUrl: toolPresentation.toolIconUrl(name),
    internal: toolPresentation.isBuiltInTool(name),
    result: {
      name,
      output: msg.content,
      success: msg.toolSuccess ?? (msg.isError ? false : undefined),
      images: msg.imageDataUrls,
    },
  }]
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
watch([
  () => chatStore.messages.length,
  () => chatStore.messages.at(-1)?.content,
  () => chatStore.messages.at(-1)?.imageDataUrls?.length,
  () => chatStore.messages.at(-1)?.videoDataUrls?.length,
  () => agentStore.executionSteps.length,
], () => {
  scrollMainToBottomIfNear()
  scrollSubAgentBoxesIfNear()
})
watch(() => agentStore.pendingHITL, scrollMainToBottomIfNear)
watch([
  () => chatStore.activeQuickResponses.length,
  generatingQuickResponses,
  generatingTitle,
], scrollMainToBottomIfNear)
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

const HOURLY_GREETINGS: Record<number, string[]> = {
  0: [
    'Midnight mode.',
    'Still building?',
    'Late-night runtime online.',
    'New day, same session?',
    'Past midnight already.',
    'One more thing before sleep?',
  ],

  1: [
    'Quiet hours.',
    'Deep work or debugging?',
    'Burning the midnight oil?',
    'The world is mostly offline.',
    'Late-night focus.',
    'Still something to solve?',
  ],

  2: [
    'Night shift active.',
    'Still up?',
    'Everything is quieter at 2 AM.',
    'Prime time for questionable ideas.',
    'Deep into the night.',
    'What’s keeping us busy?',
  ],

  3: [
    'Graveyard session.',
    'Late-night ideas?',
    'The system is still awake.',
    'This definitely counts as late.',
    '3 AM engineering?',
    'What are we still fixing?',
  ],

  4: [
    'Almost morning.',
    'Early start or late finish?',
    'Pre-dawn focus.',
    'The morning shift is approaching.',
    'Still running?',
    'One last push before sunrise?',
  ],

  5: [
    'Early start.',
    'Good morning.',
    'Fresh run, fresh context.',
    'Up before the noise.',
    'Starting early today?',
    'Morning systems online.',
  ],

  6: [
    'Morning boot-up.',
    'Ready when you are.',
    'Good morning.',
    'Early momentum.',
    'Fresh start?',
    'Let’s get the day moving.',
  ],

  7: [
    'Good morning.',
    'What are we building today?',
    'New day, clean slate.',
    'Morning. What’s first?',
    'Ready to get started?',
    'What deserves attention today?',
  ],

  8: [
    'Morning focus.',
    'Let’s get started.',
    'What should we tackle first?',
    'Time to get things moving.',
    'What’s first on the list?',
    'Ready for a productive morning?',
  ],

  9: [
    'Work mode online.',
    'Good morning.',
    'Ready for the first task.',
    'Morning momentum.',
    'What are we working on?',
    'Let’s make something happen.',
  ],

  10: [
    'Mid-morning check-in.',
    'What needs attention?',
    'Let’s make progress.',
    'Already in the flow?',
    'What are we improving today?',
    'Ready for the next task?',
  ],

  11: [
    'Almost lunch.',
    'What are we solving next?',
    'Still in the flow.',
    'One more thing before lunch?',
    'Late-morning focus.',
    'What’s next?',
  ],

  12: [
    'Lunchtime.',
    'Midday check-in.',
    'Taking a break or pushing on?',
    'Halfway through the day.',
    'Midday mode.',
    'What are we tackling this afternoon?',
  ],

  13: [
    'Back from lunch?',
    'Early afternoon mode.',
    'What’s next on the list?',
    'Afternoon session starting?',
    'Ready for round two?',
    'Let’s pick things back up.',
  ],

  14: [
    'Afternoon focus.',
    'Let’s keep momentum.',
    'What are we improving?',
    'Back into the flow.',
    'What needs solving?',
    'Plenty of day left.',
  ],

  15: [
    'Mid-afternoon run.',
    'Still going strong.',
    'Time to refine things.',
    'What are we polishing?',
    'Afternoon momentum.',
    'Let’s knock something out.',
  ],

  16: [
    'Late-afternoon focus.',
    'What should we finish today?',
    'Let’s close some loops.',
    'What’s still open?',
    'End-of-day tasks incoming?',
    'Time to wrap up the important stuff.',
  ],

  17: [
    'Wrapping up or diving in?',
    'End-of-day push.',
    'What still needs doing?',
    'One last productive stretch?',
    'Closing time approaches.',
    'Anything worth finishing today?',
  ],

  18: [
    'Good evening.',
    'Evening session?',
    'What are we working on tonight?',
    'Workday over — or not quite?',
    'Evening mode online.',
    'What’s the plan for tonight?',
  ],

  19: [
    'Evening mode.',
    'Ready for a calmer session.',
    'What’s on your mind?',
    'Back for another round?',
    'Evening focus.',
    'What are we exploring tonight?',
  ],

  20: [
    'Night work?',
    'Evening focus.',
    'Let’s build something useful.',
    'Quiet hours are starting.',
    'What are we making tonight?',
    'Time for a side project?',
  ],

  21: [
    'Late-evening session.',
    'Ideas after hours?',
    'What should we explore?',
    'Night session starting?',
    'Still got some momentum?',
    'Good time for experiments.',
  ],

  22: [
    'Night mode.',
    'Still productive?',
    'Quiet time, sharp thoughts.',
    'Late-night focus.',
    'One more problem to solve?',
    'The distractions are gone.',
  ],

  23: [
    'Almost midnight.',
    'Final task before shutdown?',
    'Late-night thoughts?',
    'Calling it soon?',
    'One last session?',
    'Let’s finish the day strong.',
  ],
}

function getRandomHourlyGreeting(): string {
  const hour = new Date().getHours()
  const options = HOURLY_GREETINGS[hour] ?? ['How can I help?']
  return options[Math.floor(Math.random() * options.length)]
}

const greeting = ref(getRandomHourlyGreeting())

// Scroll to bottom when mounting into an already-loaded conversation
// (e.g. navigating here after selectConversation was called elsewhere)
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
    <div
      v-if="forkError"
      role="alert"
      class="p-3 text-sm text-status-danger"
    >
      {{ forkError }}
    </div>
    <div
      v-if="props.searchOpen"
      role="search"
      aria-label="Search current chat"
      class="sticky top-0 z-30 flex justify-center px-3 pt-3 pointer-events-none"
    >
      <div class="pointer-events-auto flex w-full max-w-xl items-center gap-1.5 rounded-xl border border-theme-700 bg-theme-950/95 p-1.5 shadow-xl shadow-black/20 backdrop-blur">
        <Icon
          icon="lucide:search"
          class="ml-1.5 h-3.5 w-3.5 shrink-0 text-ink-muted"
        />
        <input
          ref="searchInput"
          v-model="searchQuery"
          type="search"
          class="min-w-0 flex-1 bg-transparent px-1 py-1 text-xs text-theme-200 outline-none placeholder:text-ink-faint"
          placeholder="Search this chat…"
          aria-label="Search this chat"
          @keydown.enter.prevent="moveSearchResult($event.shiftKey ? -1 : 1)"
          @keydown.esc.prevent="closeSearch"
        >
        <span
          class="min-w-16 text-right text-[10px] tabular-nums text-ink-muted"
          aria-live="polite"
        >
          {{ searchResultLabel }}
        </span>
        <button
          type="button"
          class="flex h-7 w-7 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-theme-800 hover:text-theme-200 disabled:cursor-default disabled:opacity-30"
          title="Previous result"
          aria-label="Previous search result"
          :disabled="!searchResults.length"
          @click="moveSearchResult(-1)"
        >
          <Icon
            icon="lucide:chevron-up"
            class="h-3.5 w-3.5"
          />
        </button>
        <button
          type="button"
          class="flex h-7 w-7 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-theme-800 hover:text-theme-200 disabled:cursor-default disabled:opacity-30"
          title="Next result"
          aria-label="Next search result"
          :disabled="!searchResults.length"
          @click="moveSearchResult(1)"
        >
          <Icon
            icon="lucide:chevron-down"
            class="h-3.5 w-3.5"
          />
        </button>
        <button
          type="button"
          class="flex h-7 w-7 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-theme-800 hover:text-theme-200"
          title="Close search"
          aria-label="Close chat search"
          @click="closeSearch"
        >
          <Icon
            icon="lucide:x"
            class="h-3.5 w-3.5"
          />
        </button>
      </div>
    </div>

    <!-- Loading spinner for long conversations -->
    <div
      v-if="chatStore.loadingMessages"
      class="flex flex-col items-center justify-center h-full"
    >
      <Icon
        icon="lucide:loader-2"
        class="w-8 h-8 text-ink-muted animate-spin"
      />
      <span class="text-sm text-ink-muted mt-3">Loading conversation…</span>
    </div>

    <!-- Empty state -->
    <div
      v-else-if="chatStore.messages.length === 0"
      class="flex flex-col items-center justify-center h-full text-ink-secondary"
    >
      <div class="relative flex items-center justify-center w-20 h-20 mb-6 bg-linear-to-br from-accent-500/10 to-accent-500/10 rounded-3xl border border-white/5 shadow-xl overflow-hidden">
        <RouterLink
          v-if="conversationAgentId"
          :to="{ name: 'agent-detail', params: { id: conversationAgentId }, query: { returnTo: route.fullPath } }"
          :aria-label="`Open ${activeAgentName ?? 'agent'} settings`"
          class="absolute inset-0 flex items-center justify-center"
        >
          <img
            v-if="activeAgentIconUrl"
            :src="activeAgentIconUrl"
            class="w-full h-full object-cover"
            alt=""
          >
          <Icon
            v-else
            icon="lucide:bot-message-square"
            class="w-10 h-10 text-accent-fg"
          />
        </RouterLink>
        <Icon
          v-else
          icon="lucide:message-square"
          class="w-10 h-10 text-accent-fg"
        />
      </div>
      <template v-if="!wsConnected">
        <Icon
          icon="lucide:loader-2"
          class="w-8 h-8 text-ink-muted animate-spin mb-4"
        />
        <h2 class="text-3xl font-semibold text-theme-200 tracking-tight">
          Initializing…
        </h2>
        <p class="text-sm mt-2 text-ink-muted max-w-sm text-center">
          Connecting to server and loading your data.
        </p>
      </template>
      <template v-else>
        <div class="flex items-center justify-center gap-3">
          <h2 class="text-3xl font-semibold text-theme-200 tracking-tight text-center">
            {{ greeting }}
          </h2>
          <RouterLink
            v-if="activeAgentIssues.length"
            :to="{ name: 'agent-detail', params: { id: conversationAgentId }, query: { returnTo: route.fullPath } }"
            class="inline-flex shrink-0 rounded p-1 text-status-warning focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
            :title="`Agent health warning\n${activeAgentIssues.join('\n')}\nOpen agent settings to resolve.`"
            :aria-label="`Agent health warning: ${activeAgentIssues.join(', ')}. Open agent settings.`"
          >
            <Icon
              icon="lucide:triangle-alert"
              class="h-5 w-5"
              aria-hidden="true"
            />
          </RouterLink>
        </div>
        <p class="text-sm mt-2 text-ink-muted max-w-sm text-center">
          Type a message below to begin a new conversation, or choose an agent to assist you.
        </p>
        <TransitionGroup
          tag="div"
          appear
          enter-active-class="transition duration-200 ease-out"
          enter-from-class="scale-75 opacity-0"
          enter-to-class="scale-100 opacity-100"
          leave-active-class="transition duration-150 ease-in"
          leave-from-class="scale-100 opacity-100"
          leave-to-class="scale-75 opacity-0"
          move-class="transition-transform duration-200"
          class="flex items-center justify-center gap-2"
          :class="{ 'mt-4': emptyStateSubAgents.length }"
          aria-label="Assigned sub-agents"
        >
          <span
            v-for="(subAgent, index) in visibleEmptyStateSubAgents"
            :key="subAgent.id"
            :title="subAgent.name"
            :style="{ transitionDelay: `${index * 50}ms` }"
            class="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border border-theme-700 bg-theme-800 shadow-sm"
          >
            <img
              v-if="subAgent.iconUrl"
              :src="subAgent.iconUrl"
              :alt="subAgent.name"
              class="h-full w-full object-cover"
            >
            <Icon
              v-else
              icon="lucide:bot"
              class="h-5 w-5 text-ink-secondary"
            />
          </span>
          <span
            v-if="overflowEmptyStateSubAgents.length"
            :key="'overflow-' + overflowEmptyStateSubAgents.length"
            :title="overflowEmptyStateSubAgentsTitle"
            class="flex h-10 w-10 items-center justify-center rounded-full border border-theme-700 bg-theme-800 text-xs font-medium text-ink-secondary shadow-sm"
            :style="{ transitionDelay: `${visibleEmptyStateSubAgents.length * 50}ms` }"
            aria-label="Additional assigned sub-agents"
          >
            +{{ overflowEmptyStateSubAgents.length }}
          </span>
        </TransitionGroup>
      </template>
    </div>

    <!-- Unified timeline -->
    <div
      v-else
      class="max-w-5xl mx-auto py-4"
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
            <div
              role="button"
              tabindex="0"
              class="w-full flex cursor-pointer items-center gap-2.5 px-3 py-2.5 transition-colors hover:bg-indigo-500/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400/60"
              :aria-expanded="!collapsedSubAgentGroups.has(entry.key)"
              :aria-label="`${collapsedSubAgentGroups.has(entry.key) ? 'Expand' : 'Collapse'} ${entry.agentName || entry.codename} sub-agent steps`"
              @click="toggleSubAgentCollapsed(entry.key)"
              @keydown.enter.self.prevent="toggleSubAgentCollapsed(entry.key)"
              @keydown.space.self.prevent="toggleSubAgentCollapsed(entry.key)"
            >
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
                  class="w-3.5 h-3.5 text-status-indigo"
                />
              </div>
              <!-- Agent name + codename -->
              <div class="flex-1 min-w-0 flex items-baseline gap-1.5">
                <span class="text-[13px] font-medium text-indigo-300 truncate">{{ entry.agentName || entry.codename }}</span>
                <span
                  v-if="entry.agentName && entry.agentName !== entry.codename"
                  class="text-[10px] text-status-indigo/50 truncate shrink-0"
                >{{ entry.codename }}</span>
              </div>
              <!-- Running indicator -->
              <Icon
                v-if="activeSubAgentGroupKey === entry.key"
                icon="svg-spinners:ring-resize"
                class="w-3.5 h-3.5 text-status-indigo shrink-0"
              />
              <!-- Step count badge -->
              <span class="text-[10px] text-status-indigo/50 tabular-nums shrink-0">
                {{ entry.entries.length }} step{{ entry.entries.length !== 1 ? 's' : '' }}
              </span>
              <button
                v-if="!collapsedSubAgentGroups.has(entry.key)"
                class="w-7 h-7 rounded-lg flex items-center justify-center text-status-indigo/50 hover:text-indigo-300 hover:bg-indigo-500/10 transition-colors shrink-0"
                :title="fullHeightSubAgentGroups.has(entry.key) ? 'Collapse to compact view' : 'Expand to full height'"
                @click.stop="toggleSubAgentFullHeight(entry.key)"
              >
                <Icon
                  :icon="fullHeightSubAgentGroups.has(entry.key) ? 'lucide:minimize-2' : 'lucide:maximize-2'"
                  class="w-3.5 h-3.5"
                />
              </button>
              <!-- Height toggle icon -->
              <button
                class="w-7 h-7 rounded-lg flex items-center justify-center text-status-indigo/50 hover:text-indigo-300 hover:bg-indigo-500/10 transition-colors shrink-0"
                :title="collapsedSubAgentGroups.has(entry.key) ? 'Expand sub-agent steps' : 'Collapse sub-agent steps'"
                @click.stop="toggleSubAgentCollapsed(entry.key)"
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
              <div
                v-if="entry.openingMessage"
                data-subagent-opening-message
              >
                <MessageBubble
                  role="user"
                  :content="entry.openingMessage"
                  readonly
                  fork-disabled
                />
              </div>
              <template
                v-for="inner in entry.entries"
                :key="inner.key"
              >
                <div
                  v-if="inner.type === 'message'"
                  :data-chat-search-message-id="inner.msg.id"
                  :class="{ 'ring-1 ring-inset ring-accent-400/60 rounded-2xl bg-accent-500/5': activeSearchMessageId === inner.msg.id }"
                >
                  <MessageBubble
                    v-bind="messageBubbleProps(inner, entry.entries)"
                    @retry="chatStore.retryFromMessage(inner.msg.id)"
                    @edit="(content) => chatStore.editMessage(inner.msg.id, content)"
                    @fork="forkMessage(inner.msg.id)"
                  />
                </div>
                <PreTurnContextTimeline
                  v-else-if="inner.type === 'tool-group' && inner.group.iteration === 0"
                  :steps="inner.group.steps"
                  :is-active="agentStore.isExecuting && inner.key === lastToolGroupKey"
                />
                <ToolExecutionCard
                  v-else-if="inner.type === 'tool-group'"
                  :iteration="inner.group.iteration"
                  :steps="inner.group.steps"
                  :is-active="agentStore.isExecuting && inner.key === lastToolGroupKey"
                  :delegation-handoff="inner.group.delegationHandoff"
                />
                <div
                  v-else-if="inner.type === 'saved-tool-result'"
                  class="px-4 py-1.5"
                >
                  <div class="ml-3 md:ml-12">
                    <ToolExecutionList
                      :rows="savedToolRows(inner)"
                      :is-active="false"
                      status="Result received"
                      @preview-image="lightboxSrc = $event"
                    />
                  </div>
                </div>
              </template>
            </div>
          </div>
        </div>

        <!-- Regular message (user / assistant) -->
        <div
          v-else-if="entry.type === 'message'"
          :data-chat-search-message-id="entry.msg.id"
          :class="{ 'ring-1 ring-inset ring-accent-400/60 rounded-2xl bg-accent-500/5': activeSearchMessageId === entry.msg.id }"
        >
          <MessageBubble
            v-bind="messageBubbleProps(entry)"
            @retry="chatStore.retryFromMessage(entry.msg.id)"
            @edit="(content) => chatStore.editMessage(entry.msg.id, content)"
            @fork="forkMessage(entry.msg.id)"
          />
        </div>

        <!-- Tool execution group (from live execution steps) -->
        <PreTurnContextTimeline
          v-else-if="entry.type === 'tool-group' && entry.group.iteration === 0"
          :steps="entry.group.steps"
          :is-active="agentStore.isExecuting && entry.key === lastToolGroupKey"
        />
        <ToolExecutionCard
          v-else-if="entry.type === 'tool-group'"
          :iteration="entry.group.iteration"
          :steps="entry.group.steps"
          :is-active="agentStore.isExecuting && entry.key === lastToolGroupKey"
          :delegation-handoff="entry.group.delegationHandoff"
        />

        <div
          v-else-if="entry.type === 'delegation-result'"
          class="px-4 py-1.5"
        >
          <div class="max-w-[80%] ml-3 md:ml-12 flex items-center gap-2 rounded-xl border border-indigo-500/20 bg-indigo-950/10 px-3 py-2 text-xs text-ink-secondary">
            <Icon
              :icon="entry.results.some(result => result.success === false) ? 'lucide:circle-alert' : entry.results.some(result => result.success === undefined) ? 'lucide:circle-help' : 'lucide:check-circle-2'"
              class="w-3.5 h-3.5 shrink-0"
              :class="entry.results.some(result => result.success === false) ? 'text-status-danger' : entry.results.some(result => result.success === undefined) ? 'text-ink-muted' : 'text-status-success'"
            />
            <span>{{ delegationResultLabel(entry.results) }}</span>
            <span
              v-if="entry.results.every(result => result.success !== undefined)"
              class="ml-auto text-[10px] text-ink-muted"
            >{{ entry.results.filter(result => result.success).length }}/{{ entry.results.length }} ok</span>
          </div>
          <div
            v-if="entry.results.some(result => result.success === false && (result.name === 'spawn_subagent' || result.name === 'continue_subagent'))"
            class="max-w-[80%] ml-3 md:ml-12 mt-1 max-h-40 overflow-y-auto break-words text-xs text-status-danger whitespace-pre-wrap"
          >
            {{ entry.results.filter(result => result.success === false && (result.name === 'spawn_subagent' || result.name === 'continue_subagent')).map(result => result.error || result.output).join('\n') }}
          </div>
          <details
            v-if="entry.results.some(result => result.name !== 'spawn_subagent' && result.name !== 'continue_subagent')"
            class="max-w-[80%] ml-3 md:ml-12 mt-1 rounded-xl border border-theme-700/40 bg-theme-800/40 px-3 py-2 text-xs text-ink-secondary"
          >
            <summary class="cursor-pointer">
              Other tool results
            </summary>
            <div
              v-for="(result, index) in entry.results.filter(result => result.name !== 'spawn_subagent' && result.name !== 'continue_subagent')"
              :key="`${result.toolCallId || result.name}-${index}`"
              class="mt-2 border-t border-theme-700/40 pt-2"
            >
              <div class="font-medium">
                {{ result.name }} · {{ result.success === undefined ? 'Result received' : result.success ? 'Success' : 'Failed' }}
              </div>
              <RichContent
                v-if="result.output"
                :content="result.output"
                class="mt-1 max-h-48 overflow-y-auto break-words text-xs"
              />
            </div>
          </details>
        </div>

        <ContinuationRoundMarker
          v-else-if="entry.type === 'continuation'"
          :message="entry.step.message"
        />

        <!-- Context compact event card -->
        <ContextCompactCard
          v-else-if="entry.type === 'compact-event' && entry.msg.compactEventData"
          :summary="entry.msg.compactEventData.summary"
          :compacted-message-count="entry.msg.compactEventData.compactedMessageCount"
          :model="entry.msg.compactEventData.model"
          :created-at="entry.msg.compactEventData.createdAt"
        />

        <!-- Saved result not represented by execution events -->
        <div
          v-else-if="entry.type === 'saved-tool-result'"
          class="px-4 py-1.5"
        >
          <div class="ml-3 md:ml-12">
            <ToolExecutionList
              :rows="savedToolRows(entry)"
              :is-active="false"
              status="Result received"
              @preview-image="lightboxSrc = $event"
            />
          </div>
        </div>
      </template>

      <!-- Title generation activity indicator -->
      <ChatActivityIndicator
        v-if="generatingTitle"
        class="mx-auto w-full max-w-5xl px-4 pb-1 pt-1"
        label="Generating title…"
        cancel-label="Cancel title generation"
        @cancel="chatStore.cancelPostActions()"
      />

      <!-- Quick responses -->
      <QuickResponses
        :suggestions="visibleQuickResponses"
        :loading="generatingQuickResponses"
        @select="emit('selectQuickResponse', $event)"
      />

      <!-- Working indicator (executing but not currently streaming) -->
      <ChatActivityIndicator
        v-if="agentStore.isExecuting && !chatStore.isStreaming"
        class="mx-auto w-full max-w-5xl px-4 py-2"
        label="Working…"
      />

      <!-- HITL dialog -->
      <HITLDialog />
    </div>
  </div>
  <ArtifactImageModal
    :src="lightboxSrc"
    @close="lightboxSrc = null"
  />
</template>
