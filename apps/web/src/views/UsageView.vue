<script setup lang="ts">
import UsageMetrics from '../components/shared/UsageMetrics.vue'
</script>

<template>
  <div class="h-full overflow-y-auto">
    <header class="sticky top-0 z-10 border-b border-theme-800/60 bg-theme-950/95 py-4 backdrop-blur-sm sm:py-5">
      <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <h1 class="text-2xl font-bold text-theme-100">
          Usage
        </h1>
        <p class="mt-1 text-sm leading-relaxed text-theme-500">
          Model, tool, and agent usage metrics
        </p>
      </div>
    </header>

    <div class="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <UsageMetrics />
    </div>
  </div>
</template>
