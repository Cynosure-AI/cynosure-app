<script setup lang="ts">
import { Icon } from '@iconify/vue'

defineProps<{
  icon: string
  title: string
  optional?: boolean
}>()
</script>

<template>
  <header class="mb-7 flex items-start gap-4">
    <div class="step-header-icon">
      <Icon
        :icon="icon"
        class="h-5 w-5"
      />
    </div>
    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="text-xl font-semibold tracking-tight text-theme-100 sm:text-2xl">
          {{ title }}
        </h2>
        <span
          v-if="optional"
          class="rounded-full border border-theme-600/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ink-muted"
        >Optional</span>
      </div>
      <p class="mt-1.5 text-sm leading-relaxed text-ink-muted">
        <slot />
      </p>
    </div>
  </header>
</template>

<style scoped>
.step-header-icon {
  display: grid;
  flex: 0 0 auto;
  width: 2.75rem;
  height: 2.75rem;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--color-accent-500) 35%, transparent);
  border-radius: .875rem;
  background: radial-gradient(circle at 30% 20%, color-mix(in srgb, var(--color-accent-400) 22%, transparent), color-mix(in srgb, var(--color-accent-500) 8%, transparent));
  box-shadow: 0 8px 24px -12px color-mix(in srgb, var(--color-accent-500) 60%, transparent);
  color: var(--color-accent-fg);
}
</style>
