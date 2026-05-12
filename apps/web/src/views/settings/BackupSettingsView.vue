<script setup lang="ts">
import { ref } from 'vue'
import TabBar, { type TabDef } from '../../components/shared/TabBar.vue'
import BackupExport from '../../components/settings/BackupExport.vue'
import BackupImport from '../../components/settings/BackupImport.vue'

type BackupTab = 'export' | 'import'
const activeTab = ref<BackupTab>('export')

const tabs: TabDef<BackupTab>[] = [
  { value: 'export', label: 'Export', icon: 'lucide:download' },
  { value: 'import', label: 'Import & Restore', icon: 'lucide:upload' }
]
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-3xl mx-auto py-8 px-6">
      <div class="mb-6">
        <h1 class="text-2xl font-bold text-theme-100">
          Backup & Restore
        </h1>
        <p class="text-sm text-theme-500 mt-1">
          Export your Cynosure configuration as a zip file, or restore from a previous backup
        </p>
      </div>

      <TabBar
        v-model="activeTab"
        :tabs="tabs"
        class="mb-6"
      />

      <BackupExport v-if="activeTab === 'export'" />
      <BackupImport v-else />
    </div>
  </div>
</template>
