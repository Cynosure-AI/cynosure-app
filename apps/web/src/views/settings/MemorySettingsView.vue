<script setup lang="ts">
import MemorySettings from '../../components/settings/MemorySettings.vue'
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-3xl mx-auto py-8 px-6">
      <div class="mb-6">
        <h1 class="text-2xl font-bold text-zinc-100">
          Memory &amp; Embeddings
        </h1>
        <p class="text-sm text-zinc-500 mt-1">
          Configure embedding providers and vector storage
        </p>
      </div>

      <MemorySettings />
    </div>
  </div>
</template>
