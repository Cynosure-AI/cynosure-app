<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, onBeforeUnmount, reactive, toRaw } from 'vue'
import { useChatStore, type DisplayMessage } from '../../stores/chat.store'
import { useAgentStore } from '../../stores/agent-runtime.store'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import { useAgentHealthStore } from '../../stores/agent-health.store'
import { wsConnected } from '../../api/http'
import MessageBubble from '../chat/MessageBubble.vue'
import ToolExecutionCard from '../chat/ToolExecutionCard.vue'
import PreTurnContextTimeline from '../chat/PreTurnContextTimeline.vue'
import ChatActivityIndicator from '../chat/ChatActivityIndicator.vue'
import QuickResponses from '../chat/QuickResponses.vue'
import ContextCompactCard from '../chat/ContextCompactCard.vue'
import ContinuationRoundMarker from '../chat/ContinuationRoundMarker.vue'
import WaitResumeMarker from '../chat/WaitResumeMarker.vue'
import HITLDialog from '../agent/HITLDialog.vue'
import ToolExecutionList from './ToolExecutionList.vue'
import SubAgentDelegationCard from './SubAgentDelegationCard.vue'
import ArtifactImageModal from '../shared/ArtifactImageModal.vue'
import AgentAvatar from '../shared/AgentAvatar.vue'
import { useAgentMood, type AgentMood } from '../../composables/useAgentMood'
import { useEventListener, useResizeObserver } from '@vueuse/core'
import { useToolPresentation } from '../../composables/useToolPresentation'
import { useStickyScroll } from '../../composables/useStickyScroll'
import RichContent from '../shared/RichContent.vue'
import TypewriterText from '../shared/TypewriterText.vue'
import { chatIntroTimeline } from './chatIntro'
import { Icon } from '@iconify/vue'
import { useRoute } from 'vue-router'
import { buildChatTimeline, type TimelineEntry } from '../../utils/chat-timeline'
import { groupDelegations, type DelegationEntry, type DisplayTimelineEntry } from '../../utils/delegation-timeline'
import { fileArtifactLinks, type FileArtifactLink } from '../../utils/file-artifacts'
import { getGreeting, getIncognitoGreeting } from '../../utils/greetings'
import { useCynoStore } from '../../stores/cyno.store'
import { trackThinking } from '../../utils/thinking-clock'

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
const scrollContent = ref<HTMLDivElement | null>(null)
const {
  following: followingMain,
  onScroll: onMainScroll,
  stopFollowing: stopFollowingMain,
  scrollToBottom: scrollMainToBottom,
  scrollToBottomIfFollowing: scrollMainToBottomIfFollowing,
} = useStickyScroll(scrollContainer, scrollContent)
const toolPresentation = useToolPresentation()
const lightboxSrc = ref<string | null>(null)
/** Explicit open/closed choices per sub-agent run; unset runs follow isRunExpanded. */
const runExpansion = reactive(new Map<string, boolean>())
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
  for (const delegation of delegationEntries.value) {
    const run = delegation.runs.find(candidate =>
      candidate.entries.some(inner => inner.type === 'message' && inner.msg.id === messageId))
    if (run) {
      runExpansion.set(run.key, true)
      return
    }
  }
}

function scrollToSearchResult(messageId: string): void {
  stopFollowingMain()
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

// Chats without an agent are Cyno chats; without an uploaded icon they show Cyno's generated avatar.
const cyno = useCynoStore()

const activeAgentIconUrl = computed(() => {
  if (!conversationAgentId.value) return cyno.displayIconUrl
  return agentDefs.get(conversationAgentId.value)?.iconUrl ?? null
})
/** Until the profile or definitions arrive, avatars show the logo instead of a guessed face. */
const activeAgentPending = computed(() => conversationAgentId.value ? !agentDefs.loaded : !cyno.profile)
const activeAgentAvatar = computed(() => {
  if (!conversationAgentId.value) return cyno.avatar
  return agentDefs.get(conversationAgentId.value)?.avatar ?? null
})

// One live avatar per chat: it carries the run's mood, so replies from this
// chat's own assistant drop their per-message avatar.
const { mood: liveMood, speaking: liveSpeaking } = useAgentMood()
const heroMood = computed<AgentMood>(() => {
  if (activeAgentIssues.value.length) return 'sick'
  return chatStore.activeIsTemporary ? 'shy' : 'idle'
})

// The live avatar sits at the top of this chat's latest reply. It is teleported
// into that reply's gutter, so layout carries it as the reply grows or a block
// above it expands, and it stays one instance across replies so its mood and
// motion carry over. Moving to a newer reply glides it there (FLIP).
const liveAvatarAnchorId = computed(() => {
  const ownAgentId = conversationAgentId.value ?? undefined
  for (let index = chatStore.messages.length - 1; index >= 0; index--) {
    const message = chatStore.messages[index]
    if (message.role === 'assistant' && !message.compactEventData && resolveAgentId(message) === ownAgentId) return message.id
  }
  return null
})
// A run can open several short replies in quick succession (a brief thought, a
// tool round, a few words). Within a run the avatar only moves on once a newer
// reply has lasted a moment, so quick rounds do not bounce it from reply to
// reply. A reply that answers a new message from the user takes it at once.
const LIVE_AVATAR_SETTLE_MS = 900
const liveAvatarShownId = ref<string | null>(null)
let liveAvatarSettle: ReturnType<typeof setTimeout> | undefined
watch(liveAvatarAnchorId, (id) => {
  clearTimeout(liveAvatarSettle)
  const shownIndex = chatStore.messages.findIndex((message) => message.id === liveAvatarShownId.value)
  const newTurn = shownIndex >= 0 && chatStore.messages.slice(shownIndex + 1).some((message) => message.role === 'user')
  // Move at once when there is nothing to stay on (no avatar yet, another chat, its reply is gone) or on a new turn.
  if (!id || shownIndex < 0 || newTurn) {
    liveAvatarShownId.value = id
    return
  }
  liveAvatarSettle = setTimeout(() => { liveAvatarShownId.value = liveAvatarAnchorId.value }, LIVE_AVATAR_SETTLE_MS)
}, { immediate: true })
onBeforeUnmount(() => clearTimeout(liveAvatarSettle))

// Where on its reply the avatar rests. While a run streams and the reader is
// following along, it docks at the reply's bottom edge, which is the chat's
// bottom edge, so it holds still on screen as the transcript scrolls under it.
// Afterwards it settles at the top of the reply, unless that top is already off
// screen, in which case it stays docked rather than flying up.
const liveAvatarRunning = computed(() => agentStore.isExecuting || chatStore.activeConversationIsStreaming)
const liveAvatarDock = ref<'top' | 'bottom'>('top')
function liveReplyTopVisible(): boolean {
  const container = scrollContainer.value
  const row = liveAvatar.value?.$el instanceof HTMLElement
    ? liveAvatar.value.$el.closest('[data-chat-search-message-id]')
    : null
  if (!container || !row) return true
  return row.getBoundingClientRect().top >= container.getBoundingClientRect().top
}
// Until the transcript scrolls, following moves nothing, and a bottom dock would
// just step down line by line; it only pays off once the chat overflows.
const transcriptOverflows = ref(false)
useResizeObserver(scrollContent, () => {
  const container = scrollContainer.value
  transcriptOverflows.value = Boolean(container && container.scrollHeight > container.clientHeight + 1)
})
// The end of a run reflows the chat for a moment (usage line, quick responses),
// so the resting spot is chosen once that has settled, and then left alone.
const LIVE_AVATAR_REST_DELAY_MS = 450
let liveAvatarRest: ReturnType<typeof setTimeout> | undefined
watch([liveAvatarRunning, followingMain, transcriptOverflows, liveAvatarShownId], ([running, following, overflows], previous) => {
  clearTimeout(liveAvatarRest)
  if (running) {
    liveAvatarDock.value = following && overflows ? 'bottom' : 'top'
    return
  }
  const runJustEnded = previous?.[0] === true
  const newReply = previous?.[3] !== liveAvatarShownId.value
  if (!runJustEnded && !newReply) return
  liveAvatarRest = setTimeout(() => {
    liveAvatarDock.value = liveReplyTopVisible() ? 'top' : 'bottom'
  }, runJustEnded ? LIVE_AVATAR_REST_DELAY_MS : 0)
})
onBeforeUnmount(() => clearTimeout(liveAvatarRest))

const liveAvatarTarget = computed(() => liveAvatarShownId.value
  ? `[data-live-avatar-slot="${CSS.escape(liveAvatarShownId.value)}"]`
  : null)
const liveAvatar = ref<{ $el?: Element } | null>(null)
const LIVE_AVATAR_GLIDE_MS = 520

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

watch([liveAvatarShownId, liveAvatarDock], async ([id], [previous]) => {
  const el = liveAvatar.value?.$el
  if (!id || !previous || !(el instanceof HTMLElement)) return
  // A streamed reply is swapped for its saved copy under a new id; same reply, so no glide.
  if (id !== previous && !chatStore.messages.some((message) => message.id === previous)) return
  const before = el.getBoundingClientRect()
  await nextTick()
  // Hold it where it was until the follow-scroll has landed; measuring before
  // that would glide from a spot the chat is about to scroll away from.
  const moved = el.getBoundingClientRect()
  el.style.transform = `translate(${before.left - moved.left}px, ${before.top - moved.top}px)`
  await nextFrame()
  await nextFrame()
  el.style.transform = ''
  const after = el.getBoundingClientRect()
  const dx = before.left - after.left
  const dy = before.top - after.top
  if ((Math.abs(dx) < 1 && Math.abs(dy) < 1) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  // A real move gets a little overshoot; a small correction just eases in.
  const far = Math.hypot(dx, dy) > 48
  el.animate(
    [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
    far
      ? { duration: LIVE_AVATAR_GLIDE_MS, easing: 'cubic-bezier(0.34, 1.3, 0.64, 1)' }
      : { duration: 220, easing: 'ease-out' },
  )
}, { flush: 'pre' })

// The new-chat hero follows the pointer, and glances at the composer while you type.
const heroAvatar = ref<InstanceType<typeof AgentAvatar> | null>(null)
const COMPOSER_GLANCE_MS = 1500
let composerGlance: ReturnType<typeof setTimeout> | undefined
useEventListener(document, 'input', (event) => {
  const target = event.target
  if (!heroAvatar.value || !(target instanceof HTMLElement) || target.id !== 'chat-textarea') return
  heroAvatar.value.lookAt(target)
  clearTimeout(composerGlance)
  composerGlance = setTimeout(() => heroAvatar.value?.lookAt('pointer'), COMPOSER_GLANCE_MS)
})
onBeforeUnmount(() => clearTimeout(composerGlance))

const activeAgentName = computed(() => {
  if (!conversationAgentId.value) return cyno.name
  return agentDefs.get(conversationAgentId.value)?.name ?? null
})

const emptyStateSubAgents = computed(() => {
  return chatStore.sessionSubAgentIds
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
function resolveAgentAvatar(msg: DisplayMessage) {
  if (msg.agentId) return agentDefs.get(msg.agentId)?.avatar ?? null
  return activeAgentAvatar.value
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

const generatingTitle = computed(() => chatStore.activePostActions.has('generating-title'))
const generatingQuickResponses = computed(() =>
  !agentStore.isExecuting && chatStore.activePostActions.has('generating-quick-responses'),
)
const visibleQuickResponses = computed(() => chatStore.activeQuickResponses)

// ─── Unified timeline ───────────────────────────────────────

const unifiedTimeline = computed<DisplayTimelineEntry[]>(() => groupDelegations(buildChatTimeline(
  chatStore.messages, agentStore.executionSteps,
)))

const delegationEntries = computed(() =>
  unifiedTimeline.value.filter((entry): entry is DelegationEntry => entry.type === 'delegation'))

/** A delegation stops being live once the conversation moves past it. */
const activeDelegationKey = computed(() => {
  if (!agentStore.isExecuting) return null
  const latest = unifiedTimeline.value.at(-1)
  return latest?.type === 'delegation' ? latest.key : null
})

/** Key of the last tool-group entry — only this one can show as "active" */
const lastToolGroupKey = computed(() => {
  const groups = unifiedTimeline.value.flatMap((entry) => {
    if (entry.type === 'tool-group') return [entry]
    if (entry.type === 'delegation') {
      return [
        ...(entry.call ? [entry.call] : []),
        ...entry.runs.flatMap(run => run.entries.filter(e => e.type === 'tool-group')),
      ]
    }
    return []
  })
  return groups.reduce<(typeof groups)[number] | null>((latest, group) =>
    !latest || group.ts >= latest.ts ? group : latest, null)?.key ?? null
})

/** The sub-agent run doing work right now: it is streaming or owns the active tool step. */
function liveRunKey(delegation: DelegationEntry): string | null {
  if (delegation.key !== activeDelegationKey.value) return null
  return delegation.runs.find(run => run.entries.some(inner =>
    inner.key === lastToolGroupKey.value || (inner.type === 'message' && inner.msg.isStreaming),
  ))?.key ?? null
}

/** A lone run opens while it works; parallel runs stay compact and report through their rows. */
function isRunExpanded(delegation: DelegationEntry, key: string): boolean {
  return runExpansion.get(key) ?? delegation.runs.length === 1
}

function toggleRun(delegation: DelegationEntry, key: string): void {
  runExpansion.set(key, !isRunExpanded(delegation, key))
}

function delegationResultLabel(results: Extract<TimelineEntry, { type: 'delegation-result' }>['results']): string {
  if (results.some(result => result.success === false && (result.name === 'spawn_subagent' || result.name === 'continue_subagent'))) {
    return 'Delegation failed'
  }
  if (results.some(result => result.success === false)) return 'Sub-agent returned · tool error'
  if (results.some(result => result.success === undefined)) return 'Sub-agent returned · outcome unavailable'
  return 'Sub-agent returned'
}

function collectFileArtifactsFromText(text: string, seen: Set<string>, artifacts: FileArtifactLink[]): void {
  for (const artifact of fileArtifactLinks(text)) {
    if (seen.has(artifact.href)) continue
    seen.add(artifact.href)
    artifacts.push(artifact)
  }
}

type AnyTimelineEntry = TimelineEntry | DisplayTimelineEntry

/** The tool card an entry stands for; a delegation stands for its call. */
function toolGroupOf(entry: AnyTimelineEntry): Extract<TimelineEntry, { type: 'tool-group' }> | null {
  if (entry.type === 'tool-group') return entry
  if (entry.type === 'delegation') return entry.call
  return null
}

function hasLaterToolGroupInTurn(entries: readonly AnyTimelineEntry[], index: number): boolean {
  for (let i = index + 1; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.type === 'message' && entry.msg.role === 'user') return false
    if (toolGroupOf(entry)) return true
  }
  return false
}

function assistantFileArtifacts(entry: AnyTimelineEntry, entries: readonly AnyTimelineEntry[] = unifiedTimeline.value): FileArtifactLink[] {
  if (entry.type !== 'message' || entry.msg.role !== 'assistant' || entry.msg.isStreaming) return []
  const index = entries.findIndex((candidate) => candidate.key === entry.key)
  if (index === -1 || hasLaterToolGroupInTurn(entries, index)) return []

  const artifacts: FileArtifactLink[] = []
  const seen = new Set<string>()

  for (let i = index - 1; i >= 0; i--) {
    const previous = entries[i]
    if (previous.type === 'message' && previous.msg.role === 'user') break
    const group = toolGroupOf(previous)
    if (!group) continue
    for (const step of group.group.steps) {
      for (const result of step.results || []) {
        collectFileArtifactsFromText(result.output || '', seen, artifacts)
      }
    }
  }

  collectFileArtifactsFromText(entry.msg.content, seen, artifacts)
  return artifacts.reverse()
}

/** Keep main and delegated messages consistent, including their artifact timeline. */
function messageBubbleProps(entry: Extract<TimelineEntry, { type: 'message' }>, entries: readonly AnyTimelineEntry[] = unifiedTimeline.value) {
  const { msg } = entry
  const thinkingClock = msg.thinking ? trackThinking(toRaw(msg)) : undefined
  return {
    role: msg.role,
    messageId: msg.id,
    forkDisabled: chatStore.isConversationLocked,
    createdAt: msg.createdAt,
    content: msg.content,
    thinking: msg.thinking,
    thinkingStartedAt: thinkingClock?.startedAt,
    thinkingEndedAt: thinkingClock?.endedAt,
    imageDataUrls: msg.imageDataUrls,
    videoDataUrls: msg.videoDataUrls,
    audioDataUrls: msg.audioDataUrls,
    fileAttachments: msg.fileAttachments,
    fileArtifacts: assistantFileArtifacts(entry, entries),
    agentId: resolveAgentId(msg),
    agentIconUrl: resolveAgentIconUrl(msg),
    agentAvatar: resolveAgentAvatar(msg),
    agentAvatarPending: msg.agentId ? !agentDefs.loaded : activeAgentPending.value,
    agentName: resolveAgentName(msg),
    hideAvatar: resolveAgentId(msg) === (conversationAgentId.value ?? undefined),
    liveAvatarDock: msg.id === liveAvatarShownId.value ? liveAvatarDock.value : 'top',
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

/** Map of sub-agent run key → its scrollable transcript element. */
const subAgentScrollRefs = new Map<string, HTMLElement>()
const initializedSubAgentScrolls = new Set<string>()

/** Loaded history opens with every run collapsed. */
function collapseVisibleSubAgentGroups(): void {
  nextTick(() => {
    for (const delegation of delegationEntries.value) {
      for (const run of delegation.runs) runExpansion.set(run.key, false)
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
  for (const delegation of delegationEntries.value) {
    for (const run of delegation.runs) {
      activeKeys.add(run.key)
      const el = subAgentScrollRefs.get(run.key)
      if (el && isNearScrollBottom(el)) boxesToScroll.push(el)
    }
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
  scrollMainToBottomIfFollowing()
  scrollSubAgentBoxesIfNear()
})
watch(() => agentStore.pendingHITL, scrollMainToBottomIfFollowing)
watch([
  () => chatStore.activeQuickResponses.length,
  generatingQuickResponses,
  generatingTitle,
], scrollMainToBottomIfFollowing)
// When loading finishes the spinner is replaced by rendered messages — scroll then
watch(() => chatStore.loadingMessages, (isLoading) => {
  if (isLoading) {
    runExpansion.clear()
    return
  }
  scrollMainToBottom()
  collapseVisibleSubAgentGroups()
})

// ─── Time-based greeting ────────────────────────────────────

const introGreeting = getGreeting()
const greeting = ref(introGreeting)

// The headline types out first; the subtitle and sub-agents wait for it. The
// timeline stays on the first greeting, so a re-typed one cannot re-delay them.
const CONNECTING_TITLE = 'Initializing…'
const introTimeline = computed(() => chatIntroTimeline(wsConnected.value ? introGreeting : CONNECTING_TITLE))

// Toggling incognito re-types the headline: a conspiratorial line going dark,
// the original greeting coming back. Each change remounts the typewriter.
const greetingRetypes = ref(0)
const RETYPE_START_MS = 80
const greetingTimeline = computed(() => greetingRetypes.value
  ? { start: RETYPE_START_MS, step: chatIntroTimeline(greeting.value).typeStep }
  : { start: introTimeline.value.typeStart, step: introTimeline.value.typeStep })

watch(() => chatStore.activeIsTemporary, (incognito) => {
  if (chatStore.messages.length) return
  greeting.value = incognito ? getIncognitoGreeting(greeting.value) : introGreeting
  greetingRetypes.value++
})
const introStyle = computed(() => ({
  '--intro-subtitle': `${introTimeline.value.subtitle}ms`,
  '--intro-agents': `${introTimeline.value.agents}ms`,
}))

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
    @scroll="onMainScroll"
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
      class="chat-empty-state relative isolate flex flex-col items-center justify-center h-full text-ink-secondary"
      :style="introStyle"
    >
      <div class="relative mb-5 sm:mb-6">
        <RouterLink
          :to="conversationAgentId
            ? { name: 'agent-detail', params: { id: conversationAgentId }, query: { returnTo: route.fullPath } }
            : { name: 'cyno', query: { returnTo: route.fullPath } }"
          :aria-label="`Open ${activeAgentName ?? 'agent'} settings`"
          class="chat-empty-icon chat-intro-icon relative flex items-center justify-center"
          :class="activeAgentIconUrl || activeAgentPending
            ? ['w-14 h-14 sm:w-20 sm:h-20 bg-theme-900 rounded-3xl border shadow-xl overflow-hidden', chatStore.activeIsTemporary ? 'border-dashed border-accent-500/50' : 'border-white/5']
            : 'w-20 h-20 sm:w-28 sm:h-28 rounded-full'"
        >
          <AgentAvatar
            ref="heroAvatar"
            :name="activeAgentName ?? 'Agent'"
            :icon-url="activeAgentIconUrl"
            :avatar="activeAgentAvatar"
            :mood="heroMood"
            :pending="activeAgentPending"
            animate="always"
            gaze
          />
        </RouterLink>
        <Transition
          enter-from-class="opacity-0 scale-50"
          enter-active-class="transition duration-200 ease-out"
          leave-to-class="opacity-0 scale-50"
          leave-active-class="transition duration-150 ease-in"
        >
          <span
            v-if="chatStore.activeIsTemporary"
            class="chat-incognito-badge absolute -bottom-1.5 -right-1.5 flex h-8 w-8 items-center justify-center rounded-full border-2 border-theme-900 bg-theme-800 text-accent-fg shadow-lg"
            title="Incognito chat"
          >
            <Icon
              icon="lucide:hat-glasses"
              class="h-4 w-4"
            />
          </span>
        </Transition>
      </div>
      <template v-if="!wsConnected">
        <h2 class="text-xl sm:text-3xl font-semibold text-theme-200 tracking-tight">
          <TypewriterText
            :text="CONNECTING_TITLE"
            :start="introTimeline.typeStart"
            :step="introTimeline.typeStep"
          />
        </h2>
        <p class="chat-intro-fade text-sm mt-2 text-ink-muted max-w-sm text-center">
          Connecting to server and loading your data.
        </p>
      </template>
      <template v-else>
        <div class="flex items-center justify-center gap-3">
          <h2
            class="text-xl sm:text-3xl font-semibold tracking-tight text-center transition-colors duration-300"
            :class="chatStore.activeIsTemporary ? 'chat-incognito-greeting text-theme-300' : 'text-theme-200'"
          >
            <TypewriterText
              :key="greetingRetypes"
              :text="greeting"
              :start="greetingTimeline.start"
              :step="greetingTimeline.step"
            />
          </h2>
          <RouterLink
            v-if="activeAgentIssues.length"
            :to="{ name: 'agent-detail', params: { id: conversationAgentId }, query: { returnTo: route.fullPath } }"
            class="chat-intro-fade inline-flex shrink-0 rounded p-1 text-status-warning focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
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
        <Transition
          enter-from-class="opacity-0 -translate-y-1"
          enter-active-class="transition duration-200 ease-out"
          leave-to-class="opacity-0 -translate-y-1"
          leave-active-class="transition duration-150 ease-in"
        >
          <p
            v-if="chatStore.activeIsTemporary"
            class="chat-incognito-note mt-2 inline-flex items-center gap-1.5 text-sm text-ink-muted"
          >
            Incognito chat · won't appear in your history or memory
          </p>
        </Transition>

        <TransitionGroup
          tag="div"
          appear
          appear-from-class=""
          appear-active-class="chat-intro-pop"
          appear-to-class=""
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
            :style="{ transitionDelay: `${index * 50}ms`, '--intro-index': index }"
            class="flex h-8 w-8 sm:h-10 sm:w-10 items-center justify-center overflow-hidden rounded-full border border-theme-700 bg-theme-800 shadow-sm"
          >
            <AgentAvatar
              :name="subAgent.name"
              :icon-url="subAgent.iconUrl"
              :avatar="subAgent.avatar"
            />
          </span>
          <span
            v-if="overflowEmptyStateSubAgents.length"
            :key="'overflow-' + overflowEmptyStateSubAgents.length"
            :title="overflowEmptyStateSubAgentsTitle"
            class="flex h-8 w-8 sm:h-10 sm:w-10 items-center justify-center rounded-full border border-theme-700 bg-theme-800 text-xs font-medium text-ink-secondary shadow-sm"
            :style="{ transitionDelay: `${visibleEmptyStateSubAgents.length * 50}ms`, '--intro-index': visibleEmptyStateSubAgents.length }"
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
      ref="scrollContent"
      class="max-w-5xl mx-auto py-4"
    >
      <template
        v-for="entry in unifiedTimeline"
        :key="entry.key"
      >
        <!-- Delegation: the call, each sub-agent run and what came back, in one card -->
        <SubAgentDelegationCard
          v-if="entry.type === 'delegation'"
          :delegation="entry"
          :is-executing="entry.key === activeDelegationKey"
          :live-run-key="liveRunKey(entry)"
          :is-call-active="entry.key === activeDelegationKey && entry.call?.key === lastToolGroupKey"
          :is-run-expanded="(key) => isRunExpanded(entry, key)"
          @toggle-run="(key) => toggleRun(entry, key)"
          @register-scroll="registerSubAgentScroll"
          @preview-image="lightboxSrc = $event"
        >
          <template #run="{ run }">
            <div
              v-if="run.openingMessage"
              data-subagent-opening-message
            >
              <MessageBubble
                role="user"
                :content="run.openingMessage"
                readonly
                fork-disabled
              />
            </div>
            <template
              v-for="inner in run.entries"
              :key="inner.key"
            >
              <div
                v-if="inner.type === 'message'"
                :data-chat-search-message-id="inner.msg.id"
                :class="{ 'ring-1 ring-inset ring-accent-400/60 rounded-2xl bg-accent-500/5': activeSearchMessageId === inner.msg.id }"
              >
                <MessageBubble
                  v-bind="messageBubbleProps(inner, run.entries)"
                  @retry="chatStore.retryFromMessage(inner.msg.id)"
                  @edit="(content) => chatStore.editMessage(inner.msg.id, content)"
                  @fork="forkMessage(inner.msg.id)"
                />
              </div>
              <PreTurnContextTimeline
                v-else-if="inner.type === 'tool-group' && inner.group.iteration === 0"
                :steps="inner.group.steps"
                :is-active="entry.key === activeDelegationKey && inner.key === lastToolGroupKey"
              />
              <ToolExecutionCard
                v-else-if="inner.type === 'tool-group'"
                :iteration="inner.group.iteration"
                :steps="inner.group.steps"
                :is-active="entry.key === activeDelegationKey && inner.key === lastToolGroupKey"
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
          </template>
        </SubAgentDelegationCard>

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
          <div class="max-w-[80%] ml-3 md:ml-12 flex items-center gap-2 rounded-xl border border-theme-700/50 bg-theme-800/30 px-3 py-2 text-xs text-ink-secondary">
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

      <!-- Pending schedule_wait -->
      <WaitResumeMarker
        v-if="chatStore.activeConversationId && !agentStore.isExecuting && !chatStore.isStreaming"
      />

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

      <!-- Live avatar: one per chat, at the top of the latest reply, reacting to the run -->
      <Teleport
        v-if="liveAvatarTarget"
        :to="liveAvatarTarget"
        defer
      >
        <RouterLink
          ref="liveAvatar"
          :to="conversationAgentId
            ? { name: 'agent-detail', params: { id: conversationAgentId }, query: { returnTo: route.fullPath } }
            : { name: 'cyno', query: { returnTo: route.fullPath } }"
          :title="activeAgentName ?? undefined"
          tabindex="-1"
          aria-hidden="true"
          class="chat-live-avatar flex h-10 w-10 items-center justify-center overflow-hidden"
          :class="activeAgentIconUrl ? 'rounded-full bg-theme-800 shadow-sm ring-1 ring-theme-700/50' : ''"
        >
          <AgentAvatar
            :name="activeAgentName ?? 'Agent'"
            :icon-url="activeAgentIconUrl"
            :avatar="activeAgentAvatar"
            :mood="liveMood"
            :speaking="liveSpeaking"
            :pending="activeAgentPending"
            animate="always"
          />
        </RouterLink>
      </Teleport>
    </div>
  </div>
  <ArtifactImageModal
    :src="lightboxSrc"
    @close="lightboxSrc = null"
  />
</template>

<style scoped>
/* Incognito whispers its headline: slanted, a touch looser, with a fainter caret. */
.chat-incognito-greeting {
  font-style: italic;
  letter-spacing: 0.005em;
  --tw-caret-opacity: 0.55;
}

/* New-chat intro, timed by chatIntro.ts: the icon materializes, the headline
   types itself out (TypewriterText), then the subtitle and sub-agents follow. */
@media (prefers-reduced-motion: no-preference) {
  .chat-intro-icon {
    animation:
      chat-intro-materialize 760ms cubic-bezier(0.22, 1, 0.36, 1) both,
      chat-intro-ping 1100ms 420ms ease-out;
  }

  .chat-intro-fade {
    animation: chat-intro-rise 560ms var(--intro-subtitle) cubic-bezier(0.22, 1, 0.36, 1) both;
  }

  /* Only the first appearance waits for the greeting; later additions use the quick enter. */
  .chat-intro-pop {
    animation: chat-intro-pop 520ms calc(var(--intro-agents) + var(--intro-index, 0) * 70ms) cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }
}

@keyframes chat-intro-materialize {
  from {
    opacity: 0;
    transform: scale(0.82);
    filter: blur(8px);
  }
  60% {
    filter: blur(0);
  }
  to {
    opacity: 1;
    transform: none;
    filter: none;
  }
}

/* One ring leaves the icon as it locks in. An outline, so the icon keeps its own shadow. */
@keyframes chat-intro-ping {
  from {
    outline: 1.5px solid color-mix(in srgb, var(--color-accent-500) 60%, transparent);
    outline-offset: 0;
  }
  to {
    outline: 1.5px solid color-mix(in srgb, var(--color-accent-500) 0%, transparent);
    outline-offset: 22px;
  }
}

@keyframes chat-intro-rise {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes chat-intro-pop {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.6);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
