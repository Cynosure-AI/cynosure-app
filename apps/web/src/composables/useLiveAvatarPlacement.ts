import { nextTick, onScopeDispose, ref, watch, type Ref } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import type { DisplayMessage } from '../stores/chat.store'

export interface LiveAvatarPlacementOptions {
  /** The latest rendered reply the avatar should sit on. */
  anchorId: Readonly<Ref<string | null>>
  /** The chat's own messages, used to tell a new turn from another round of the same run. */
  messages: Readonly<Ref<readonly DisplayMessage[]>>
  /** A run is in progress for this chat. */
  running: Readonly<Ref<boolean>>
  /** The transcript is following new content at the bottom. */
  following: Readonly<Ref<boolean>>
  scrollContainer: Readonly<Ref<HTMLElement | null>>
  scrollContent: Readonly<Ref<HTMLElement | null>>
  /** The avatar's own element once it is teleported into its reply. */
  avatarEl: () => HTMLElement | null
}

// A run can open several short replies in quick succession (a brief thought, a
// tool round, a few words). Within a run the avatar only moves on once a newer
// reply has lasted a moment, so quick rounds do not bounce it from reply to
// reply. A reply that answers a new message from the user takes it at once.
const SETTLE_MS = 900
// The end of a run reflows the chat for a moment (usage line, quick responses),
// so the resting spot is chosen once that has settled, and then left alone.
const REST_DELAY_MS = 450
const GLIDE_MS = 520

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

/**
 * Which reply the chat's live avatar sits on, and at which edge. The avatar is
 * teleported into that reply's gutter, so layout carries it as the reply grows
 * or a block above it expands, and it stays one instance across replies so its
 * mood and motion carry over. Moving to a newer reply glides it there (FLIP).
 *
 * While a run streams and the reader is following along, it docks at the
 * reply's bottom edge, which is the chat's bottom edge, so it holds still on
 * screen as the transcript scrolls under it. Afterwards it settles at the top
 * of the reply, unless that top is already off screen, in which case it stays
 * docked rather than flying up.
 */
export function useLiveAvatarPlacement(options: LiveAvatarPlacementOptions) {
  const { anchorId, messages, running, following, scrollContainer, scrollContent, avatarEl } = options

  const shownId = ref<string | null>(null)
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  watch(anchorId, (id) => {
    clearTimeout(settleTimer)
    const shownIndex = messages.value.findIndex((message) => message.id === shownId.value)
    const newTurn = shownIndex >= 0 && messages.value.slice(shownIndex + 1).some((message) => message.role === 'user')
    // Move at once when there is nothing to stay on (no avatar yet, another chat, its reply is gone) or on a new turn.
    if (!id || shownIndex < 0 || newTurn) {
      shownId.value = id
      return
    }
    settleTimer = setTimeout(() => { shownId.value = anchorId.value }, SETTLE_MS)
  }, { immediate: true })

  // Until the transcript scrolls, following moves nothing, and a bottom dock would
  // just step down line by line; it only pays off once the chat overflows.
  const overflows = ref(false)
  useResizeObserver(scrollContent, () => {
    const container = scrollContainer.value
    overflows.value = Boolean(container && container.scrollHeight > container.clientHeight + 1)
  })

  function replyTopVisible(): boolean {
    const container = scrollContainer.value
    const row = avatarEl()?.closest('[data-chat-search-message-id]')
    if (!container || !row) return true
    return row.getBoundingClientRect().top >= container.getBoundingClientRect().top
  }

  const dock = ref<'top' | 'bottom'>('top')
  let restTimer: ReturnType<typeof setTimeout> | undefined
  watch([running, following, overflows, shownId], ([isRunning, isFollowing, isOverflowing, id], previous) => {
    clearTimeout(restTimer)
    if (isRunning) {
      dock.value = isFollowing && isOverflowing ? 'bottom' : 'top'
      return
    }
    const runJustEnded = previous?.[0] === true
    const newReply = previous?.[3] !== id
    if (!runJustEnded && !newReply) return
    restTimer = setTimeout(() => {
      dock.value = replyTopVisible() ? 'top' : 'bottom'
    }, runJustEnded ? REST_DELAY_MS : 0)
  })

  // Each move supersedes the one before: a newer move abandons an older one
  // still waiting on frames, and cancels its running glide.
  let glideGeneration = 0
  let glide: Animation | undefined
  watch([shownId, dock], async ([id], [previous]) => {
    const generation = ++glideGeneration
    const el = avatarEl()
    if (!id || !previous || !el) return
    // A streamed reply is swapped for its saved copy under a new id; same reply, so no glide.
    if (id !== previous && !messages.value.some((message) => message.id === previous)) return
    glide?.cancel()
    const before = el.getBoundingClientRect()
    await nextTick()
    if (generation !== glideGeneration) return
    // Hold it where it was until the follow-scroll has landed; measuring before
    // that would glide from a spot the chat is about to scroll away from.
    const moved = el.getBoundingClientRect()
    el.style.transform = `translate(${before.left - moved.left}px, ${before.top - moved.top}px)`
    await nextFrame()
    await nextFrame()
    el.style.transform = ''
    if (generation !== glideGeneration) return
    const after = el.getBoundingClientRect()
    const dx = before.left - after.left
    const dy = before.top - after.top
    if ((Math.abs(dx) < 1 && Math.abs(dy) < 1) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    // A real move gets a little overshoot; a small correction just eases in.
    const far = Math.hypot(dx, dy) > 48
    glide = el.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      far
        ? { duration: GLIDE_MS, easing: 'cubic-bezier(0.34, 1.3, 0.64, 1)' }
        : { duration: 220, easing: 'ease-out' },
    )
  }, { flush: 'pre' })

  onScopeDispose(() => {
    clearTimeout(settleTimer)
    clearTimeout(restTimer)
    glideGeneration++
    glide?.cancel()
  })

  return { shownId, dock }
}
