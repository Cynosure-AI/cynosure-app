<script setup lang="ts">
import { ref, computed } from 'vue'

const props = withDefaults(defineProps<{
  /** Disable the tooltip (still renders the slot, just no popover) */
  disabled?: boolean
  /** Preferred placement: center above trigger, follow mouse, or right of trigger */
  placement?: 'above' | 'mouse' | 'right'
  /** Max width in pixels */
  maxWidth?: number
  /** Use block layout (full width) instead of inline-flex */
  block?: boolean
}>(), {
  disabled: false,
  placement: 'above',
  maxWidth: 260,
  block: false,
})

const triggerRef = ref<HTMLElement | null>(null)
const hovered = ref(false)
const mousePos = ref({ x: 0, y: 0 })

// Incremented on each mouseenter to force fresh getBoundingClientRect()
const hoverTick = ref(0)

const popoverStyle = computed(() => {
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  hoverTick.value // reactive dependency — recalculates on each hover
  const style: Record<string, string> = {
    position: 'fixed',
    maxWidth: `${props.maxWidth}px`,
  }
  if (props.placement === 'mouse') {
    const popoverWidth = props.maxWidth
    let left = mousePos.value.x + 12
    if (left + popoverWidth > window.innerWidth - 8) left = mousePos.value.x - popoverWidth - 12
    style.top = `${mousePos.value.y - 8}px`
    style.left = `${left}px`
    style.transform = 'translateY(-100%)'
    return style
  }
  const el = triggerRef.value
  if (!el) {
    style.top = '0'
    style.left = '0'
    return style
  }
  const rect = el.getBoundingClientRect()
  if (props.placement === 'right') {
    let top = rect.top + rect.height / 2
    if (top < 8) top = 8
    style.top = `${top}px`
    style.left = `${rect.right + 8}px`
    style.transform = 'translateY(-50%)'
    return style
  }
  // "above" placement: right-aligned above the trigger element
  const right = window.innerWidth - rect.right
  style.bottom = `${window.innerHeight - rect.top + 6}px`
  style.right = `${right}px`
  return style
})

function onEnter(e: MouseEvent) {
  hoverTick.value++
  hovered.value = true
  mousePos.value = { x: e.clientX, y: e.clientY }
}

function onMove(e: MouseEvent) {
  mousePos.value = { x: e.clientX, y: e.clientY }
}

function onLeave() {
  hovered.value = false
}
</script>

<template>
  <div
    ref="triggerRef"
    :class="block ? 'flex w-full' : 'inline-flex'"
    @mouseenter="onEnter"
    @mousemove="onMove"
    @mouseleave="onLeave"
  >
    <slot />
  </div>

  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="hovered && !disabled"
        class="rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl shadow-black/40 p-2.5 text-xs pointer-events-none z-9999"
        :style="popoverStyle"
      >
        <slot name="content" />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
