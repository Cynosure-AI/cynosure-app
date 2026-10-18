<script setup lang="ts">
defineProps<{ hasTools?: boolean; hasProject?: boolean }>()
</script>

<template>
  <div
    class="composer-tabs relative z-10 ml-4 mt-0.5 flex h-6.5 max-w-[calc(100%-2rem)] items-center text-xs text-theme-200"
    :class="hasTools ? 'w-full' : 'w-fit'"
    role="group"
    aria-label="Chat project and selected tools"
    data-testid="composer-tabs"
  >
    <div
      v-if="hasProject"
      class="composer-project-segment relative flex h-full min-w-0 shrink-0 items-center pl-4 pr-2.5"
      :class="hasTools ? 'max-w-[45%]' : 'composer-project-segment-only max-w-full pr-4'"
    >
      <slot name="project" />
    </div>
    <span
      v-if="hasProject && hasTools"
      class="composer-project-divider mb-px h-[calc(100%-1px)] w-px shrink-0"
      aria-hidden="true"
      data-testid="composer-tabs-divider"
    />
    <div
      v-if="hasTools"
      class="flex h-full min-w-0 flex-1 items-center pr-4"
      :class="hasProject ? 'pl-2' : 'pl-4'"
    >
      <slot />
    </div>
  </div>
</template>

<style scoped>
/* Two stacked trapezoids: the outer one is the edge line, the inner one the
   fill. The fill reaches the top so the tab merges into the composer, covering
   its bottom border, and the edge shows only on the slanted sides and bottom. */
.composer-tabs {
  isolation: isolate;
  --composer-tabs-slant: 10px;
}

.composer-tabs::before,
.composer-tabs::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
}

.composer-tabs::before {
  background: var(--theme-composer-tab-line);
  clip-path: polygon(0 0, 100% 0, calc(100% - var(--composer-tabs-slant)) 100%, var(--composer-tabs-slant) 100%);
}

.composer-tabs::after {
  background: var(--theme-composer-tab-background);
  clip-path: polygon(
    1px 0,
    calc(100% - 1px) 0,
    calc(100% - var(--composer-tabs-slant) - 0.6px) calc(100% - 1px),
    calc(var(--composer-tabs-slant) + 0.6px) calc(100% - 1px)
  );
}

/* The project is a filled section of the same bevel, inset from its outline. */
.composer-project-segment {
  isolation: isolate;
}

.composer-project-segment::before {
  content: '';
  position: absolute;
  inset: 0 0 1px 1px;
  z-index: -1;
  background: color-mix(in srgb, var(--color-accent-500) 10%, var(--color-theme-700));
  clip-path: polygon(0 0, 100% 0, 100% 100%, calc(var(--composer-tabs-slant) - 0.4px) 100%);
}

.composer-project-segment-only::before {
  right: 1px;
  clip-path: polygon(0 0, 100% 0, calc(100% - var(--composer-tabs-slant) + 0.4px) 100%, calc(var(--composer-tabs-slant) - 0.4px) 100%);
}

.composer-project-divider {
  background: color-mix(in srgb, var(--color-accent-500) 25%, var(--color-theme-600));
}
</style>
