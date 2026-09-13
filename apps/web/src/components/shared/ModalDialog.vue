<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { Icon } from '@iconify/vue'

const props = defineProps<{
  /** Controls visibility */
  show: boolean
  /** Title shown in header */
  title: string
  /** Iconify icon name for the header badge */
  icon?: string
  /** Color theme for the icon badge: 'accent' | 'red' | 'amber' */
  iconColor?: 'accent' | 'red' | 'amber'
  /** Max width class (default: 'max-w-md') */
  maxWidth?: string
  /** Max height class for the dialog panel (default: 'max-h-[90vh]') */
  maxHeight?: string
  /** Allow content to overflow the panel (useful for nested dropdowns) */
  overflowVisible?: boolean
  /** Allow body slot to overflow instead of clipping with vertical scrolling */
  bodyOverflowVisible?: boolean
  /** Clip body overflow so a nested component can own scrolling */
  bodyOverflowHidden?: boolean
  /** Raise dialogs opened from inside another modal above their parent overlay. */
  layer?: 'default' | 'nested'
}>()

const emit = defineEmits<{
  close: []
}>()

const panelRef = ref<HTMLElement | null>(null)
const titleId = `dialog-title-${useId()}`
let previouslyFocused: HTMLElement | null = null

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function close(): void {
  emit('close')
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (event.key !== 'Tab' || !panelRef.value) return

  const focusable = [...panelRef.value.querySelectorAll<HTMLElement>(focusableSelector)]
    .filter((element) => !element.hidden && element.getClientRects().length > 0)
  if (!focusable.length) {
    event.preventDefault()
    panelRef.value.focus()
    return
  }

  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(() => props.show, async (show) => {
  if (show) {
    previouslyFocused = document.activeElement as HTMLElement | null
    await nextTick()
    const first = panelRef.value?.querySelector<HTMLElement>(focusableSelector)
    ;(first || panelRef.value)?.focus()
    document.addEventListener('keydown', handleKeydown)
  } else {
    document.removeEventListener('keydown', handleKeydown)
    previouslyFocused?.focus()
    previouslyFocused = null
  }
}, { immediate: true })

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="show"
      class="fixed inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      :class="layer === 'nested' ? 'z-[1000]' : 'z-30'"
      :style="layer === 'nested' ? { zIndex: 1000 } : undefined"
      @click.self="close"
    >
      <div
        ref="panelRef"
        v-bind="$attrs"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        class="bg-theme-900 border border-theme-800 rounded-2xl shadow-2xl w-full flex flex-col"
        :class="[
          maxWidth || 'max-w-md',
          maxHeight || 'max-h-[90vh]',
          overflowVisible ? 'overflow-visible' : 'overflow-hidden'
        ]"
      >
        <div
          class="p-6 flex flex-col min-h-0 flex-1"
        >
          <!-- Header -->
          <div class="flex items-center gap-3 mb-4 shrink-0">
            <div
              v-if="icon"
              class="p-2 rounded-lg"
              :class="{
                'bg-accent-500/20 text-accent-400': iconColor === 'accent' || !iconColor,
                'bg-red-500/20 text-red-400': iconColor === 'red',
                'bg-amber-500/20 text-amber-400': iconColor === 'amber',
              }"
            >
              <Icon
                :icon="icon"
                class="w-6 h-6"
              />
            </div>
            <h3
              :id="titleId"
              class="text-lg font-semibold text-theme-100"
            >
              {{ title }}
            </h3>
          </div>

          <!-- Body slot -->
          <div
            class="min-h-0 flex-1"
            :class="bodyOverflowHidden ? 'overflow-hidden' : bodyOverflowVisible ? 'overflow-visible' : 'overflow-y-auto'"
          >
            <slot />
          </div>

          <!-- Actions slot -->
          <div
            v-if="$slots.actions"
            class="flex flex-col gap-3 mt-6 shrink-0"
          >
            <slot name="actions" />
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
