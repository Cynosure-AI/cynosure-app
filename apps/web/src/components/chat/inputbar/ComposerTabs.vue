<script setup lang="ts">
defineProps<{ hasTools?: boolean; hasProject?: boolean }>()
</script>

<template>
  <div
    class="composer-tabs relative z-10 ml-4 mt-0.5 flex h-6.5 max-w-[calc(100%-2rem)] items-center px-4 pb-0.5 text-xs text-theme-200"
    :class="hasTools ? 'w-full' : 'w-fit'"
    role="group"
    aria-label="Chat project and selected tools"
    data-testid="composer-tabs"
  >
    <div
      v-if="hasProject"
      class="flex min-w-0 shrink-0 items-center"
      :class="hasTools ? 'max-w-[45%]' : 'max-w-full'"
    >
      <slot name="project" />
    </div>
    <span
      v-if="hasProject && hasTools"
      class="mx-2 h-3.5 w-px shrink-0 bg-theme-600"
      aria-hidden="true"
      data-testid="composer-tabs-divider"
    />
    <slot v-if="hasTools" />
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

</style>
