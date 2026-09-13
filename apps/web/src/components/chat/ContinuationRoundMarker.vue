<script setup lang="ts">
import { Icon } from '@iconify/vue'

defineProps<{
  message?: string
}>()
</script>

<template>
  <div class="px-4 py-2" data-testid="continuation-round-marker">
    <div class="ml-0 flex max-w-[85%] items-center gap-3 md:ml-12">
      <div class="h-px flex-1 bg-linear-to-r from-transparent to-accent-500/25" />
      <div class="flex shrink-0 items-center gap-2 rounded-full border border-accent-500/25 bg-accent-500/8 px-3 py-1.5 text-xs text-accent-300 shadow-sm shadow-accent-950/10">
        <Icon
          icon="lucide:refresh-cw"
          class="h-3.5 w-3.5 shrink-0"
        />
        <span class="font-medium">Continuing in a new round</span>
        <span v-if="message" class="hidden text-theme-500 sm:inline">· {{ message }}</span>
      </div>
      <div class="h-px flex-1 bg-linear-to-l from-transparent to-accent-500/25" />
    </div>
  </div>
</template>
