<script setup lang="ts">
import { Icon } from '@iconify/vue'

withDefaults(defineProps<{
  label: string
  icon?: string
  cancelLabel?: string
}>(), {
  icon: 'svg-spinners:ring-resize',
  cancelLabel: undefined,
})

defineEmits<{ cancel: [] }>()
</script>

<template>
  <div class="flex items-center gap-1.5 text-[11px] text-theme-500" role="status">
    <Icon :icon="icon" class="h-3 w-3 text-accent-fg" />
    <span>{{ label }}</span>
    <button
      v-if="cancelLabel"
      type="button"
      class="ml-0.5 flex h-5 w-5 items-center justify-center rounded text-theme-600 transition hover:bg-red-500/10 hover:text-red-300"
      :title="cancelLabel"
      :aria-label="cancelLabel"
      @click="$emit('cancel')"
    >
      <Icon icon="lucide:x" class="h-3 w-3" />
    </button>
  </div>
</template>
