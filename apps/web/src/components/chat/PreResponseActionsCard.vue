<script setup lang="ts">
import { Icon } from '@iconify/vue'

defineProps<{ actions: string[] }>()
defineEmits<{ cancel: [] }>()

const labels: Record<string, string> = {
  'generating-title': 'Generating conversation title',
}

function label(action: string): string {
  return labels[action] || action.replace(/-/g, ' ')
}
</script>

<template>
  <div class="px-4 py-1.5">
    <article class="ml-3 max-w-[50%] overflow-hidden rounded-xl border border-theme-700/60 bg-theme-800/40 md:ml-12">
      <div class="flex items-center gap-2.5 px-3.5 py-3">
        <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-theme-700/40 text-accent-400">
          <Icon
            icon="svg-spinners:ring-resize"
            class="h-3.5 w-3.5"
          />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block text-[12px] font-semibold text-theme-200">Preparing response</span>
          <span class="block text-[10px] text-theme-500">Pre-response actions running alongside context preparation</span>
        </span>
        <span class="rounded-md bg-theme-700/40 px-1.5 py-0.5 text-[10px] tabular-nums text-theme-300">
          {{ actions.length }} running
        </span>
        <button
          type="button"
          class="flex h-6 w-6 items-center justify-center rounded-md text-theme-600 transition hover:bg-red-500/10 hover:text-red-300"
          title="Cancel pre-response actions"
          aria-label="Cancel pre-response actions"
          @click="$emit('cancel')"
        >
          <Icon
            icon="lucide:x"
            class="h-3.5 w-3.5"
          />
        </button>
      </div>
      <div class="border-t border-theme-700/45 px-3.5 py-2.5">
        <div
          v-for="action in actions"
          :key="action"
          class="flex items-center gap-2 text-[11px] text-theme-300"
        >
          <Icon
            icon="lucide:heading"
            class="h-3.5 w-3.5 text-theme-500"
          />
          <span>{{ label(action) }}</span>
          <span class="ml-auto text-[10px] text-theme-500">Running…</span>
        </div>
      </div>
    </article>
  </div>
</template>
