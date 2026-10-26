import { nextTick, onScopeDispose, readonly, ref, watch, type Ref } from 'vue'

/** Keep following content growth until the reader scrolls away from the bottom. */
export function useStickyScroll(
  container: Ref<HTMLElement | null>,
  content: Ref<HTMLElement | null>,
  threshold = 72,
) {
  const following = ref(true)

  function stopFollowing(): void {
    following.value = false
  }

  function onScroll(): void {
    const el = container.value
    if (el) following.value = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
  }

  function followBottom(): void {
    const el = container.value
    if (following.value && el) el.scrollTop = el.scrollHeight
  }

  function scrollToBottomIfFollowing(): void {
    // Recheck after rendering so a user scroll can cancel a queued follow.
    void nextTick(followBottom)
  }

  function scrollToBottom(): void {
    following.value = true
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

  return { following: readonly(following), onScroll, stopFollowing, scrollToBottom, scrollToBottomIfFollowing }
}
