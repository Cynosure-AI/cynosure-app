<script setup lang="ts">
import BackupSettings from '../../components/settings/BackupSettings.vue'
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-3xl mx-auto py-8 px-6">
      <div class="mb-6">
        <h1 class="text-2xl font-bold text-zinc-100">
          Backup & Restore
        </h1>
        <p class="text-sm text-zinc-500 mt-1">
          Export your OpenAgent configuration as a zip file, or restore from a previous backup
        </p>
      </div>
      <BackupSettings />
    </div>
  </div>
</template>
