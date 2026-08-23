<script setup lang="ts">
import { Icon } from '@iconify/vue'

withDefaults(defineProps<{
  detailOpen: boolean
  mobileBackLabel?: string
}>(), {
  mobileBackLabel: 'Sections',
})

const emit = defineEmits<{
  back: []
}>()
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0">
    <aside
      class="h-full min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-theme-950/60 lg:w-72 lg:flex-none lg:border-r lg:border-theme-800"
      :class="detailOpen ? 'hidden lg:flex' : 'flex'"
    >
      <slot name="sidebar" />
    </aside>

    <section
      class="h-full min-h-0 min-w-0 flex-1 flex-col"
      :class="detailOpen ? 'flex' : 'hidden lg:flex'"
    >
      <div class="shrink-0 border-b border-theme-800 bg-theme-950/95 px-3 py-2 lg:hidden">
        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-theme-400 transition-colors hover:bg-theme-800 hover:text-theme-100"
          @click="emit('back')"
        >
          <Icon
            icon="lucide:arrow-left"
            class="h-4 w-4"
          />
          {{ mobileBackLabel }}
        </button>
      </div>

      <div class="min-h-0 min-w-0 flex-1 overflow-hidden">
        <slot />
      </div>
    </section>
  </div>
</template>
