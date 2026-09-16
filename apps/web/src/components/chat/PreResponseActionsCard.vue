<script setup lang="ts">
import { Icon } from '@iconify/vue'

defineProps<{ actions: string[] }>()
defineEmits<{ cancel: [] }>()
</script>

<template>
  <div
    v-if="actions.includes('generating-title')"
    class="mx-auto flex w-full max-w-5xl items-center gap-1.5 px-4 pb-1 pt-1 text-[11px] text-theme-500"
    role="status"
  >
    <Icon icon="svg-spinners:ring-resize" class="h-3 w-3 text-accent-400" />
    <span>Generating title…</span>
    <button
      type="button"
      class="ml-0.5 flex h-5 w-5 items-center justify-center rounded text-theme-600 transition hover:bg-red-500/10 hover:text-red-300"
      title="Cancel title generation"
      aria-label="Cancel title generation"
      @click="$emit('cancel')"
    >
      <Icon icon="lucide:x" class="h-3 w-3" />
    </button>
  </div>
</template>
