import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import { useAgentStore } from '../stores/agent-runtime.store'
import { useChatStore, type DisplayMessage } from '../stores/chat.store'

/** Expressions an assistant's avatar can hold; each maps to a blobatar pose. */
export type AgentMood =
  | 'idle' | 'thinking' | 'happy' | 'sad' | 'mad' | 'surprised' | 'unsure' | 'smug' | 'sleepy' | 'shy' | 'sick'

export interface AgentMoodInput {
  /** A run is in progress for this chat. */
  executing: boolean
  /** Reply text is arriving right now. */
  streamingText: boolean
  /** The current run's latest tool round has a failed call. */
  toolFailed: boolean
  /** The latest assistant reply, once the run is over. */
  lastReply: Pick<DisplayMessage, 'isError' | 'stopped'> | null
  /** Assistant replies in a row, counting back from the latest, that ended in an error. */
  errorStreak: number
  /** The run paused itself with a scheduled wait and will continue later. */
  waiting: boolean
}

/** The mood a chat's state calls for, before any short-lived reaction. */
export function deriveAgentMood(input: AgentMoodInput): AgentMood {
  if (input.executing) {
    if (input.streamingText) return 'idle'
    return input.toolFailed ? 'unsure' : 'thinking'
  }
  if (input.waiting) return 'sleepy'
  if (input.lastReply?.isError) return input.errorStreak >= 2 ? 'mad' : 'sad'
  if (input.lastReply?.stopped) return 'sleepy'
  return 'idle'
}

/** Count trailing assistant replies that failed; user turns in between do not break the streak. */
export function countErrorStreak(messages: readonly DisplayMessage[]): number {
  let streak = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    if (!message.isError) break
    streak++
  }
  return streak
}

/** Poses a working assistant cycles through, so a long think does not look frozen. */
export const THINKING_CYCLE: readonly AgentMood[] = ['thinking', 'unsure', 'thinking', 'smug']
export const THINKING_POSE_MS = 3200

export const HAPPY_BURST_MS = 1400
export const SURPRISE_BURST_MS = 1600

/**
 * The live mood of the active chat's assistant. Finishing a run cleanly shows a
 * short happy burst, and a new approval request a short surprise; everything
 * else is held for as long as the state lasts.
 */
export function useAgentMood(): { mood: Ref<AgentMood>; speaking: Ref<boolean> } {
  const chatStore = useChatStore()
  const agentStore = useAgentStore()

  const lastAssistant = computed(() => {
    for (let index = chatStore.messages.length - 1; index >= 0; index--) {
      const message = chatStore.messages[index]
      if (message.role === 'assistant') return message
    }
    return null
  })

  const executing = computed(() => agentStore.isExecuting || chatStore.activeConversationIsStreaming)
  const speaking = computed(() => Boolean(
    chatStore.activeConversationIsStreaming && lastAssistant.value?.isStreaming && lastAssistant.value.content,
  ))
  const toolFailed = computed(() => {
    const latest = agentStore.executionSteps[agentStore.executionSteps.length - 1]
    return Boolean(latest?.results?.some((result) => result.success === false))
  })

  const base = computed(() => deriveAgentMood({
    executing: executing.value,
    streamingText: speaking.value,
    toolFailed: toolFailed.value,
    lastReply: lastAssistant.value,
    errorStreak: countErrorStreak(chatStore.messages),
    waiting: Boolean(chatStore.pendingWait),
  }))

  // While thinking, step through a few poses; each think starts from 'thinking'.
  const thinkingStep = ref(0)
  let thinkingTimer: ReturnType<typeof setInterval> | undefined
  watch(() => base.value === 'thinking', (active) => {
    clearInterval(thinkingTimer)
    thinkingStep.value = 0
    if (active) thinkingTimer = setInterval(() => { thinkingStep.value++ }, THINKING_POSE_MS)
  }, { immediate: true })
  onScopeDispose(() => clearInterval(thinkingTimer))
  const settled = computed(() => base.value === 'thinking'
    ? THINKING_CYCLE[thinkingStep.value % THINKING_CYCLE.length]
    : base.value)

  const burst = ref<AgentMood | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  function flash(mood: AgentMood, ms: number) {
    clearTimeout(timer)
    burst.value = mood
    timer = setTimeout(() => { burst.value = null }, ms)
  }
  function clearBurst() {
    clearTimeout(timer)
    burst.value = null
  }

  watch([executing, () => chatStore.activeConversationId], ([now, chat], [before, previousChat]) => {
    // A reaction belongs to the chat it happened in; switching chats is not a finished run.
    if (now || chat !== previousChat) return clearBurst()
    if (before && base.value === 'idle') flash('happy', HAPPY_BURST_MS)
  })
  watch(() => agentStore.pendingHITL?.taskId, (id, previous) => {
    if (id && id !== previous) flash('surprised', SURPRISE_BURST_MS)
  })
  onScopeDispose(() => clearTimeout(timer))

  const mood = computed(() => burst.value ?? settled.value)
  return { mood, speaking }
}
