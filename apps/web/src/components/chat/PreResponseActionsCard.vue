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
    <article class="ml-3 max-w-[50%] overflow-hidden rounded-2xl border border-sky-400/20 bg-[radial-gradient(circle_at_0_0,rgb(14_165_233_/_0.10),transparent_42%),linear-gradient(145deg,rgb(15_23_42_/_0.90),rgb(8_24_38_/_0.84))] shadow-[0_8px_24px_rgb(0_0_0_/_0.12)] md:ml-12">
      <div class="flex items-center gap-2.5 px-3.5 py-3">
        <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-sky-400/10 text-sky-300 ring-1 ring-sky-300/15">
          <Icon
            icon="svg-spinners:ring-resize"
            class="h-3.5 w-3.5"
          />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block text-[12px] font-semibold text-theme-200">Preparing response</span>
          <span class="block text-[10px] text-theme-500">Pre-response actions running alongside context preparation</span>
        </span>
        <span class="rounded-md bg-sky-400/10 px-1.5 py-0.5 text-[10px] tabular-nums text-sky-200">
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
      <div class="border-t border-sky-300/10 px-3.5 py-2.5">
        <div
          v-for="action in actions"
          :key="action"
          class="flex items-center gap-2 text-[11px] text-theme-300"
        >
          <Icon
            icon="lucide:heading"
            class="h-3.5 w-3.5 text-sky-300"
          />
          <span>{{ label(action) }}</span>
          <span class="ml-auto text-[10px] text-sky-300/70">Running…</span>
        </div>
      </div>
    </article>
  </div>
</template>
