<script setup lang="ts">
import UsageMetrics from '../components/shared/UsageMetrics.vue'
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-4xl mx-auto py-8 px-6">
      <!-- Header -->
      <div class="mb-8">
        <h1 class="text-2xl font-bold text-zinc-100">
          Usage
        </h1>
        <p class="text-sm text-zinc-500 mt-1">
          Model, tool, and agent usage metrics
        </p>
      </div>

      <UsageMetrics />
    </div>
  </div>
</template>
