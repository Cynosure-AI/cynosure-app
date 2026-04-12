<script setup lang="ts">
import ProviderSettings from '../../components/settings/ProviderSettings.vue'
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-3xl mx-auto py-8 px-6">
      <div class="mb-6">
        <h1 class="text-2xl font-bold text-zinc-100">
          LLM Providers
        </h1>
        <p class="text-sm text-zinc-500 mt-1">
          Manage your AI provider configurations and API keys
        </p>
      </div>
      <ProviderSettings />
    </div>
  </div>
</template>
