<script setup lang="ts">
import { Icon } from '@iconify/vue'

defineProps<{ actions: string[] }>()
defineEmits<{ cancel: [] }>()
</script>

<template>
  <div v-if="actions.includes('generating-title')" class="px-4 py-1.5">
    <article class="title-generation-card ml-3 max-w-[50%] md:ml-12">
      <div class="flex items-center gap-2.5 px-3.5 py-3">
        <span class="card-icon">
          <Icon icon="svg-spinners:ring-resize" class="h-3.5 w-3.5" />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block text-[12px] font-semibold text-theme-200">Conversation title</span>
          <span class="block truncate text-[11px] text-theme-400" role="status">Generating title…</span>
        </span>
        <button
          type="button"
          class="flex h-6 w-6 items-center justify-center rounded-md text-theme-600 transition hover:bg-red-500/10 hover:text-red-300"
          title="Cancel title generation"
          aria-label="Cancel title generation"
          @click="$emit('cancel')"
        >
          <Icon icon="lucide:x" class="h-3.5 w-3.5" />
        </button>
      </div>
    </article>
  </div>
</template>

<style scoped>
.title-generation-card {
  overflow: hidden;
  color: var(--color-theme-200);
  border: 1px solid color-mix(in srgb, var(--color-theme-700) 65%, transparent);
  border-radius: .75rem;
  background: color-mix(in srgb, var(--color-theme-800) 42%, transparent);
}

.card-icon {
  display: flex;
  height: 1.5rem;
  width: 1.5rem;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border-radius: .5rem;
  background: color-mix(in srgb, var(--color-theme-700) 48%, transparent);
  color: var(--color-theme-300);
}
</style>
