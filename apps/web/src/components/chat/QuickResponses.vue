<script setup lang="ts">
import ChatActivityIndicator from './ChatActivityIndicator.vue'

defineProps<{ suggestions: string[]; loading?: boolean }>()
const emit = defineEmits<{ select: [suggestion: string] }>()
</script>

<template>
  <div
    v-if="loading || suggestions.length"
    class="mx-auto w-full max-w-5xl px-4 pb-3 pt-1"
    aria-label="Quick responses"
  >
    <ChatActivityIndicator
      class="mb-1.5"
      :label="loading ? 'Thinking of follow-ups…' : 'Quick responses'"
      :icon="loading ? 'svg-spinners:ring-resize' : 'lucide:sparkles'"
    />
    <div
      v-if="suggestions.length"
      class="flex flex-wrap gap-2"
    >
      <button
        v-for="(suggestion, index) in suggestions.slice(0, 3)"
        :key="suggestion"
        type="button"
        :style="{ '--qr-index': index }"
        class="quick-response max-w-full rounded-full border border-theme-700 bg-theme-800/70 px-3 py-1.5 text-left text-xs text-theme-300 transition hover:-translate-y-px hover:border-accent-500/60 hover:bg-accent-500/10 hover:text-theme-100 active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/70"
        :title="`Send quick response: ${suggestion}`"
        @click="emit('select', suggestion)"
      >
        {{ suggestion }}
      </button>
    </div>
  </div>
</template>

<style scoped>
@media (prefers-reduced-motion: no-preference) {
  .quick-response {
    animation: quick-response-in 320ms calc(var(--qr-index) * 70ms) cubic-bezier(0.22, 1, 0.36, 1) both;
  }
}

@keyframes quick-response-in {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.96);
  }
}
</style>
