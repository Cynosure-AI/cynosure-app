<script setup lang="ts">
import { computed, ref } from 'vue'

const props = withDefaults(defineProps<{
  placement?: 'above' | 'right' | 'below'
  maxWidth?: number
  closeDelay?: number
}>(), {
  placement: 'above',
  maxWidth: 220,
  closeDelay: 120,
})

const triggerRef = ref<HTMLElement | null>(null)
const open = ref(false)
const hoverTick = ref(0)
let closeTimer: ReturnType<typeof setTimeout> | null = null

const menuStyle = computed(() => {
  const style: Record<string, string> = {
    position: 'fixed',
    maxWidth: `${props.maxWidth}px`,
    '--hover-tick': String(hoverTick.value),
  }
  const el = triggerRef.value
  if (!el) {
    style.top = '0'
    style.left = '0'
    return style
  }

  const rect = el.getBoundingClientRect()
  if (props.placement === 'below') {
    const maxLeft = window.innerWidth - props.maxWidth - 8
    style.top = `${rect.bottom + 6}px`
    style.left = `${Math.max(8, Math.min(rect.left, maxLeft))}px`
    return style
  }

  if (props.placement === 'right') {
    let top = rect.top + rect.height / 2
    if (top < 8) top = 8
    style.top = `${top}px`
    style.left = `${rect.right + 8}px`
    style.transform = 'translateY(-50%)'
    return style
  }

  const right = window.innerWidth - rect.right
  style.bottom = `${window.innerHeight - rect.top + 6}px`
  style.right = `${right}px`
  return style
})

function show(): void {
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
  hoverTick.value++
  open.value = true
}

function close(): void {
  open.value = false
}

function scheduleClose(): void {
  if (closeTimer) clearTimeout(closeTimer)
  closeTimer = setTimeout(close, props.closeDelay)
}

function toggle(): void {
  if (open.value) {
    close()
  } else {
    show()
  }
}
</script>

<template>
  <div
    ref="triggerRef"
    class="inline-flex"
    @mouseenter="show"
    @mouseleave="scheduleClose"
    @focusin="show"
    @focusout="scheduleClose"
  >
    <slot
      name="trigger"
      :open="open"
      :toggle="toggle"
      :close="close"
    />
  </div>

  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="open"
        class="rounded-lg border border-theme-700 bg-theme-900 shadow-xl shadow-black/40 p-1.5 text-xs z-50"
        :style="menuStyle"
        @mouseenter="show"
        @mouseleave="scheduleClose"
        @focusin="show"
        @focusout="scheduleClose"
      >
        <slot
          name="content"
          :close="close"
        />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.12s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
