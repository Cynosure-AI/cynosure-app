<script setup lang="ts">
import AppearanceSettings from '../../components/settings/AppearanceSettings.vue'
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-4xl mx-auto py-8 px-6">
      <div class="mb-6">
        <h1 class="text-2xl font-bold text-theme-100">
          Appearance
        </h1>
        <p class="text-sm text-theme-500 mt-1">
          Customize the app theme and chat display preferences
        </p>
      </div>

      <AppearanceSettings />
    </div>
  </div>
</template>
