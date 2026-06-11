<script setup lang="ts">
defineProps<{
  label: string
}>()
</script>

<template>
  <div class="pt-2 pb-1 first:pt-0">
    <div class="flex items-center gap-3">
      <h3 class="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-theme-500">
        {{ label }}
      </h3>
      <div class="h-px flex-1 bg-theme-800/80" />
    </div>
  </div>
</template>
