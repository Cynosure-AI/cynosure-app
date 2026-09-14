<script setup lang="ts">
import { Icon } from '@iconify/vue'

defineProps<{ actions: string[] }>()
defineEmits<{ cancel: [] }>()
</script>

<template>
  <div v-if="actions.includes('generating-title')" class="px-4 py-1.5">
    <article class="ml-3 max-w-[50%] rounded-xl border border-violet-500/20 bg-violet-500/5 md:ml-12">
      <div class="flex items-center gap-2.5 px-3.5 py-2.5">
        <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-400">
          <Icon icon="lucide:heading" class="h-3.5 w-3.5" />
        </span>
        <span class="flex min-w-0 flex-1 items-center gap-2">
          <span class="text-[12px] font-medium text-theme-300">Generating conversation title</span>
          <Icon icon="svg-spinners:ring-resize" class="h-3 w-3 shrink-0 text-violet-400" />
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
