<script setup lang="ts">
import { ref, computed } from 'vue'

const props = withDefaults(defineProps<{
  /** Disable the tooltip (still renders the slot, just no popover) */
  disabled?: boolean
  /** Preferred horizontal placement: center above trigger, or follow mouse */
  placement?: 'above' | 'mouse'
  /** Max width in pixels */
  maxWidth?: number
}>(), {
  disabled: false,
  placement: 'above',
  maxWidth: 260,
})

const triggerRef = ref<HTMLElement | null>(null)
const hovered = ref(false)
const mousePos = ref({ x: 0, y: 0 })

const popoverStyle = computed<Record<string, string>>(() => {
  if (props.placement === 'mouse') {
    const popoverWidth = props.maxWidth
    let left = mousePos.value.x + 12
    if (left + popoverWidth > window.innerWidth - 8) left = mousePos.value.x - popoverWidth - 12
    return {
      position: 'fixed',
      top: `${mousePos.value.y - 8}px`,
      left: `${left}px`,
      transform: 'translateY(-100%)',
      maxWidth: `${props.maxWidth}px`,
    }
  }
  // "above" placement: center above the trigger element
  const el = triggerRef.value
  if (!el) return { position: 'fixed', top: '0', left: '0', maxWidth: `${props.maxWidth}px` }
  const rect = el.getBoundingClientRect()
  const centerX = rect.left + rect.width / 2
  const halfW = props.maxWidth / 2
  let left = centerX - halfW
  if (left < 8) left = 8
  if (left + props.maxWidth > window.innerWidth - 8) left = window.innerWidth - 8 - props.maxWidth
  return {
    position: 'fixed',
    bottom: `${window.innerHeight - rect.top + 6}px`,
    left: `${left}px`,
    maxWidth: `${props.maxWidth}px`,
  }
})

function onEnter(e: MouseEvent) {
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
    class="inline-flex"
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
