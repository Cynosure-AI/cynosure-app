<script setup lang="ts">
import { Icon } from '@iconify/vue'

defineProps<{
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
}>()

const emit = defineEmits<{
  close: []
}>()
</script>

<template>
  <Teleport to="body">
    <div
      v-if="show"
      class="fixed inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      @click.self="emit('close')"
    >
      <div
        v-bind="$attrs"
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
            <h3 class="text-lg font-semibold text-theme-100">
              {{ title }}
            </h3>
          </div>

          <!-- Body slot -->
          <div
            class="min-h-0 flex-1"
            :class="bodyOverflowVisible ? 'overflow-visible' : 'overflow-y-auto'"
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
