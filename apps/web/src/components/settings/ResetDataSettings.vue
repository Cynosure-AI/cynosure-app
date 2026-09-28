<script setup lang="ts">
import { Icon } from '@iconify/vue'
import BackupReset from './BackupReset.vue'
import BaseCard from '../shared/BaseCard.vue'
import SettingsSubheading from './SettingsSubheading.vue'

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
    <SettingsSubheading
      v-if="showSection('reset-data')"
      label="Data Reset"
    />

    <BaseCard
      v-if="showSection('reset-data')"
      class="p-5 space-y-4 border-red-500/20"
    >
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg bg-red-500/10 flex items-center justify-center">
          <Icon
            icon="lucide:trash-2"
            class="w-5 h-5 text-status-danger"
          />
        </div>
        <div>
          <h3 class="text-sm font-medium text-theme-200">
            Reset Data
          </h3>
          <p class="text-xs text-theme-500 mt-0.5">
            Clear selected data areas or return to a clean state
          </p>
        </div>
      </div>
      <div class="pt-1 border-t border-theme-700">
        <BackupReset />
      </div>
    </BaseCard>
  </div>
</template>
