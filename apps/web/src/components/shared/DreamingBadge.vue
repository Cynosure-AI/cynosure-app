<script setup lang="ts">
import { Icon } from '@iconify/vue'

/** A drifting moon that marks a chat Dream is reviewing in the background. */
withDefaults(defineProps<{
  /** corner: pinned to an avatar's corner. inline: sits in a row's status slot. */
  variant?: 'corner' | 'inline'
  label?: string
}>(), {
  variant: 'corner',
  label: 'Dreaming over this chat',
})
</script>

<template>
  <span
    class="dreaming-badge pointer-events-auto flex items-center justify-center"
    :class="variant === 'corner'
      ? 'absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-theme-950/90'
      : 'h-3 w-3 shrink-0'"
    role="img"
    :aria-label="label"
    :title="label"
  >
    <Icon
      icon="lucide:moon"
      class="dreaming-moon text-indigo-300"
      :class="variant === 'corner' ? 'h-2 w-2' : 'h-3 w-3'"
    />
  </span>
</template>

<style scoped>
.dreaming-moon {
  animation: dreaming-drift 3.6s ease-in-out infinite;
  filter: drop-shadow(0 0 2px rgb(165 180 252 / 0.55));
}

@keyframes dreaming-drift {
  0%, 100% {
    transform: translateY(0.5px) rotate(-8deg);
    opacity: 0.75;
  }
  50% {
    transform: translateY(-0.5px) rotate(8deg);
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .dreaming-moon {
    animation: none;
  }
}
</style>
