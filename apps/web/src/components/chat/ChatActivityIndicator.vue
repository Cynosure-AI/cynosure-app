<script setup lang="ts">
import { computed } from 'vue'
import { Icon } from '@iconify/vue'

const props = withDefaults(defineProps<{
  label: string
  icon?: string
  cancelLabel?: string
}>(), {
  icon: 'svg-spinners:ring-resize',
  cancelLabel: undefined,
})

defineEmits<{ cancel: [] }>()

/** A spinner means work is underway, so the label shimmers along with it. */
const active = computed(() => props.icon.startsWith('svg-spinners:'))
</script>

<template>
  <div class="chat-activity flex items-center gap-1.5 text-[11px] text-ink-muted" role="status">
    <Icon :icon="icon" class="h-3 w-3 text-accent-fg" />
    <span :class="{ 'text-shimmer': active }">{{ label }}</span>
    <button
      v-if="cancelLabel"
      type="button"
      class="ml-0.5 flex h-5 w-5 items-center justify-center rounded text-ink-faint transition hover:bg-red-500/10 hover:text-red-300"
      :title="cancelLabel"
      :aria-label="cancelLabel"
      @click="$emit('cancel')"
    >
      <Icon icon="lucide:x" class="h-3 w-3" />
    </button>
  </div>
</template>

<style scoped>
@media (prefers-reduced-motion: no-preference) {
  .chat-activity {
    animation: chat-activity-in 260ms ease-out both;
  }
}

@keyframes chat-activity-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
}
</style>
