<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { DEFAULT_PROJECT_ICON } from '../../utils/project-format'

withDefaults(defineProps<{
  project: { icon?: string; color?: string }
  /** Show the icon on a tinted tile instead of bare. */
  tile?: boolean
}>(), { tile: false })
</script>

<template>
  <span
    v-if="tile"
    class="inline-flex shrink-0 items-center justify-center rounded-lg"
    :style="{ backgroundColor: `color-mix(in srgb, ${project.color || 'var(--color-accent-500)'} 20%, transparent)` }"
    aria-hidden="true"
  >
    <Icon
      :icon="project.icon || DEFAULT_PROJECT_ICON"
      class="h-1/2 w-1/2"
      :style="{ color: project.color || 'var(--color-accent-500)' }"
    />
  </span>
  <Icon
    v-else
    :icon="project.icon || DEFAULT_PROJECT_ICON"
    class="shrink-0"
    :style="{ color: project.color || 'var(--color-accent-500)' }"
    aria-hidden="true"
  />
</template>
