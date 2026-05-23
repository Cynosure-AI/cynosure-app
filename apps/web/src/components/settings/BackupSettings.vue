<script setup lang="ts">
import { Icon } from '@iconify/vue'
import BackupExport from './BackupExport.vue'
import BackupImport from './BackupImport.vue'
import BaseCard from '../shared/BaseCard.vue'

const props = withDefaults(defineProps<{
  visibleSections?: string[]
}>(), {
  visibleSections: () => []
})

function showSection(id: string): boolean {
  return props.visibleSections.length === 0 || props.visibleSections.includes(id)
}
</script>

<template>
  <div class="space-y-4">
    <!-- Export -->
    <BaseCard
      v-if="showSection('backup-export')"
      class="p-5 space-y-4"
    >
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center">
          <Icon
            icon="lucide:download"
            class="w-5 h-5 text-theme-400"
          />
        </div>
        <div>
          <h3 class="text-sm font-medium text-theme-200">
            Export Backup
          </h3>
          <p class="text-xs text-theme-500 mt-0.5">
            Download your configuration as a zip file
          </p>
        </div>
      </div>
      <div class="pt-1 border-t border-theme-700">
        <BackupExport />
      </div>
    </BaseCard>

    <!-- Import & Restore -->
    <BaseCard
      v-if="showSection('backup-import')"
      class="p-5 space-y-4"
    >
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center">
          <Icon
            icon="lucide:upload"
            class="w-5 h-5 text-theme-400"
          />
        </div>
        <div>
          <h3 class="text-sm font-medium text-theme-200">
            Import & Restore
          </h3>
          <p class="text-xs text-theme-500 mt-0.5">
            Restore from a previous backup file
          </p>
        </div>
      </div>
      <div class="pt-1 border-t border-theme-700">
        <BackupImport />
      </div>
    </BaseCard>
  </div>
</template>
