import { nextTick, onScopeDispose, watch, type Ref } from 'vue'

/** Keep following content growth until the reader scrolls away from the bottom. */
export function useStickyScroll(
  container: Ref<HTMLElement | null>,
  content: Ref<HTMLElement | null>,
  threshold = 72,
) {
  let following = true

  function stopFollowing(): void {
    following = false
  }

  function onScroll(): void {
    const el = container.value
    if (el) following = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
  }

  function followBottom(): void {
    const el = container.value
    if (following && el) el.scrollTop = el.scrollHeight
  }

  function scrollToBottomIfFollowing(): void {
    // Recheck after rendering so a user scroll can cancel a queued follow.
    void nextTick(followBottom)
  }

  function scrollToBottom(): void {
    following = true
    scrollToBottomIfFollowing()
  }

  // Observe actual layout, including child-only updates (HITL expansion,
  // transitions and loaded media), rather than rechecking the enlarged gap.
  const observer = new ResizeObserver(followBottom)
  watch([container, content], ([viewport, transcript]) => {
    observer.disconnect()
    if (viewport) observer.observe(viewport)
    if (transcript) observer.observe(transcript)
  }, { flush: 'post', immediate: true })
  onScopeDispose(() => observer.disconnect())

  return { onScroll, stopFollowing, scrollToBottom, scrollToBottomIfFollowing }
}
