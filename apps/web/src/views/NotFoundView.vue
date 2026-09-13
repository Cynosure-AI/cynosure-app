<script setup lang="ts">
import { Icon } from '@iconify/vue'
</script>

<template>
  <section class="flex h-full items-center justify-center px-6 py-12 text-center">
    <div class="max-w-md">
      <div class="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-theme-700 bg-theme-800 text-theme-400">
        <Icon
          icon="lucide:banana"
          class="h-7 w-7"
        />
      </div>
      <p class="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-accent-400">
        Page not found
      </p>
      <h1 class="text-2xl font-semibold text-theme-100">
        This destination doesn’t exist
      </h1>
      <p class="mt-3 text-sm leading-6 text-theme-400">
        The address may be outdated or mistyped. Return to chat to continue working.
      </p>
      <RouterLink
        to="/chat"
        class="mt-6 inline-flex items-center gap-2 rounded-lg bg-accent-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-500"
      >
        <Icon
          icon="lucide:message-square"
          class="h-4 w-4"
        />
        Return to chat
      </RouterLink>
    </div>
  </section>
</template>
