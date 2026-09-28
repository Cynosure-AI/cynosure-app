<script setup lang="ts">
import { Icon } from "@iconify/vue";

defineProps<{
  segments: Array<{ label: string; disabled?: boolean }>;
  homeDisabled?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
}>();

const emit = defineEmits<{
  home: [];
  back: [];
  forward: [];
  segmentClick: [index: number];
}>();
</script>

<template>
  <div class="mb-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
    <div class="flex min-w-0 items-center gap-2">
      <div class="flex shrink-0 items-center rounded-lg border border-theme-800 bg-theme-900/60 p-0.5">
        <button
          type="button"
          :disabled="homeDisabled"
          class="flex h-7 w-7 items-center justify-center rounded-md text-accent-fg transition-colors hover:bg-accent-500/10 hover:text-accent-fg disabled:cursor-not-allowed disabled:opacity-30"
          title="Home"
          aria-label="Go to memory root"
          @click="emit('home')"
        >
          <Icon
            icon="lucide:house"
            class="h-3.5 w-3.5"
          />
        </button>
        <button
          type="button"
          :disabled="!canGoBack"
          class="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-theme-800 hover:text-theme-200 disabled:cursor-not-allowed disabled:opacity-30"
          title="Back"
          aria-label="Go back"
          @click="emit('back')"
        >
          <Icon
            icon="lucide:arrow-left"
            class="h-3.5 w-3.5"
          />
        </button>
        <button
          type="button"
          :disabled="!canGoForward"
          class="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-theme-800 hover:text-theme-200 disabled:cursor-not-allowed disabled:opacity-30"
          title="Forward"
          aria-label="Go forward"
          @click="emit('forward')"
        >
          <Icon
            icon="lucide:arrow-right"
            class="h-3.5 w-3.5"
          />
        </button>
      </div>

      <nav
        v-if="segments.length"
        class="flex min-w-0 flex-1 items-center overflow-x-auto rounded-lg border border-theme-800 bg-theme-900/40 px-3 py-1.5 text-xs"
        aria-label="Memory folder path"
      >
        <template
          v-for="(segment, index) in segments"
          :key="`${segment.label}-${index}`"
        >
          <Icon
            v-if="index > 0"
            icon="lucide:chevron-right"
            class="h-3 w-3 shrink-0 text-theme-700"
          />
          <button
            type="button"
            :disabled="segment.disabled"
            class="shrink-0 rounded px-1.5 py-0.5 transition-colors enabled:text-accent-fg enabled:hover:bg-theme-800 enabled:hover:text-accent-fg disabled:cursor-default disabled:font-medium disabled:text-theme-200"
            @click="emit('segmentClick', index)"
          >
            {{ segment.label }}
          </button>
        </template>
        <slot name="path-actions" />
      </nav>
    </div>
    <div
      v-if="$slots.actions"
      class="flex shrink-0 items-center gap-2"
    >
      <slot name="actions" />
    </div>
  </div>
</template>
