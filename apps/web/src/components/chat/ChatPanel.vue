<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, reactive } from 'vue'
import { useChatStore, type DisplayMessage } from '../../stores/chat.store'
import { useAgentStore } from '../../stores/agent-runtime.store'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
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
import CollapsibleSection from '../shared/CollapsibleSection.vue'
import { Icon } from '@iconify/vue'
import { buildChatTimeline, type TimelineEntry } from '../../utils/chat-timeline'
import { fileArtifactLinks, type FileArtifactLink } from '../../utils/file-artifacts'

const props = withDefaults(defineProps<{
  searchOpen?: boolean
}>(), {
  searchOpen: false,
})

const emit = defineEmits<{ closeSearch: []; selectQuickResponse: [suggestion: string] }>()

const chatStore = useChatStore()
const agentStore = useAgentStore()
const agentDefs = useAgentDefinitionsStore()
const prefs = usePreferencesStore()
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
const expandedFallback = ref<Set<string>>(new Set())
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

const activeAgentIconUrl = computed(() => {
  if (!conversationAgentId.value) return null
  return agentDefs.get(conversationAgentId.value)?.iconUrl ?? null
})

const activeAgentName = computed(() => {
  if (!conversationAgentId.value) return null
  return agentDefs.get(conversationAgentId.value)?.name ?? null
})

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
  chatStore.messages, agentStore.executionSteps, conversationAgentId.value,
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
watch(() => chatStore.messages[chatStore.messages.length - 1]?.videoDataUrls?.length, () => { scrollMainToBottomIfNear(); scrollSubAgentBoxesIfNear() })
watch(() => agentStore.executionSteps.length, () => { scrollMainToBottomIfNear(); scrollSubAgentBoxesIfNear() })
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
  0:  ['Midnight mode.', 'Still building?', 'Late-night runtime online.'],
  1:  ['Quiet hours.', 'Deep work or debugging?', 'Burning the midnight oil?'],
  2:  ['Night shift active.', 'Still up?', 'Everything is quieter at 2 AM.'],
  3:  ['Graveyard session.', 'Late-night ideas?', 'The system is still awake.'],
  4:  ['Almost morning.', 'Early start or late finish?', 'Pre-dawn focus.'],
  5:  ['Early start.', 'Good morning.', 'Fresh run, fresh context.'],
  6:  ['Morning boot-up.', 'Ready when you are.', 'Good morning.'],
  7:  ['Good morning.', 'What are we building today?', 'New day, clean slate.'],
  8:  ['Morning focus.', 'Let’s get started.', 'What should we tackle first?'],
  9:  ['Work mode online.', 'Good morning.', 'Ready for the first task.'],
  10: ['Mid-morning check-in.', 'What needs attention?', 'Let’s make progress.'],
  11: ['Almost lunch.', 'What are we solving next?', 'Still in the flow.'],
  12: ['Lunchtime.', 'Midday check-in.', 'Taking a break or pushing on?'],
  13: ['Back from lunch?', 'Early afternoon mode.', 'What’s next on the list?'],
  14: ['Afternoon focus.', 'Let’s keep momentum.', 'What are we improving?'],
  15: ['Mid-afternoon run.', 'Still going strong.', 'Time to refine things.'],
  16: ['Late-afternoon focus.', 'What should we finish today?', 'Let’s close some loops.'],
  17: ['Wrapping up or diving in?', 'End-of-day push.', 'What still needs doing?'],
  18: ['Good evening.', 'Evening session?', 'What are we working on tonight?'],
  19: ['Evening mode.', 'Ready for a calmer session.', 'What’s on your mind?'],
  20: ['Night work?', 'Evening focus.', 'Let’s build something useful.'],
  21: ['Late-evening session.', 'Ideas after hours?', 'What should we explore?'],
  22: ['Night mode.', 'Still productive?', 'Quiet time, sharp thoughts.'],
  23: ['Almost midnight.', 'Final task before shutdown?', 'Late-night thoughts?'],
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
      class="p-3 text-sm text-red-400"
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
          class="ml-1.5 h-3.5 w-3.5 shrink-0 text-theme-500"
        />
        <input
          ref="searchInput"
          v-model="searchQuery"
          type="search"
          class="min-w-0 flex-1 bg-transparent px-1 py-1 text-xs text-theme-200 outline-none placeholder:text-theme-600"
          placeholder="Search this chat…"
          aria-label="Search this chat"
          @keydown.enter.prevent="moveSearchResult($event.shiftKey ? -1 : 1)"
          @keydown.esc.prevent="closeSearch"
        >
        <span
          class="min-w-16 text-right text-[10px] tabular-nums text-theme-500"
          aria-live="polite"
        >
          {{ searchResultLabel }}
        </span>
        <button
          type="button"
          class="flex h-7 w-7 items-center justify-center rounded-lg text-theme-500 transition-colors hover:bg-theme-800 hover:text-theme-200 disabled:cursor-default disabled:opacity-30"
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
          class="flex h-7 w-7 items-center justify-center rounded-lg text-theme-500 transition-colors hover:bg-theme-800 hover:text-theme-200 disabled:cursor-default disabled:opacity-30"
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
          class="flex h-7 w-7 items-center justify-center rounded-lg text-theme-500 transition-colors hover:bg-theme-800 hover:text-theme-200"
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
        class="w-8 h-8 text-theme-500 animate-spin"
      />
      <span class="text-sm text-theme-500 mt-3">Loading conversation…</span>
    </div>

    <!-- Empty state -->
    <div
      v-else-if="chatStore.messages.length === 0"
      class="flex flex-col items-center justify-center h-full text-theme-400"
    >
      <div class="relative flex items-center justify-center w-20 h-20 mb-6 bg-linear-to-br from-accent-500/10 to-accent-500/10 rounded-3xl border border-white/5 shadow-xl overflow-hidden">
        <!--Icon Wrapped into a Routerlink to the agents config-->
        <RouterLink
          v-if="activeAgentIconUrl"
          :to="`/agents/${chatStore.activeAgentId}`"
          class="absolute inset-0 w-full h-full"
        >
          <img
            :src="activeAgentIconUrl"
            class="w-full h-full object-cover"
            alt=""
          >
        </RouterLink>
        <Icon
          v-else
          icon="lucide:bot-message-square"
          class="w-10 h-10 text-accent-400"
        />
      </div>
      <template v-if="!wsConnected">
        <Icon
          icon="lucide:loader-2"
          class="w-8 h-8 text-theme-500 animate-spin mb-4"
        />
        <h2 class="text-3xl font-semibold text-theme-200 tracking-tight">
          Initializing…
        </h2>
        <p class="text-sm mt-2 text-theme-500 max-w-sm text-center">
          Connecting to server and loading your data.
        </p>
      </template>
      <template v-else>
        <h2 class="text-3xl font-semibold text-theme-200 tracking-tight text-center">
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
                @click.stop="toggleSubAgentFullHeight(entry.key)"
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
                    :role="inner.msg.role"
                    :message-id="inner.msg.id"
                    :fork-disabled="chatStore.isConversationLocked"
                    :created-at="inner.msg.createdAt"
                    :content="inner.msg.content"
                    :thinking="inner.msg.thinking"
                    :image-data-urls="inner.msg.imageDataUrls"
                    :video-data-urls="inner.msg.videoDataUrls"
                    :audio-data-urls="inner.msg.audioDataUrls"
                    :file-attachments="inner.msg.fileAttachments"
                    :file-artifacts="assistantFileArtifacts(inner, entry.entries)"
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
        <div
          v-else-if="entry.type === 'message'"
          :data-chat-search-message-id="entry.msg.id"
          :class="{ 'ring-1 ring-inset ring-accent-400/60 rounded-2xl bg-accent-500/5': activeSearchMessageId === entry.msg.id }"
        >
          <MessageBubble
            :role="entry.msg.role"
            :message-id="entry.msg.id"
            :fork-disabled="chatStore.isConversationLocked"
            :created-at="entry.msg.createdAt"
            :content="entry.msg.content"
            :thinking="entry.msg.thinking"
            :image-data-urls="entry.msg.imageDataUrls"
            :video-data-urls="entry.msg.videoDataUrls"
            :audio-data-urls="entry.msg.audioDataUrls"
            :file-attachments="entry.msg.fileAttachments"
            :file-artifacts="assistantFileArtifacts(entry)"
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
        />

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
</template>
