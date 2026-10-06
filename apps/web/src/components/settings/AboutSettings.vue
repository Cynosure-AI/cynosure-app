<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { api } from '../../api/client'
import { useAppBranding } from '../../composables/useAppBranding'
import { useAppUpdater } from '../../composables/useAppUpdater'
import BaseCard from '../shared/BaseCard.vue'
import AppUpdatePanel from './AppUpdatePanel.vue'
import SettingsSubheading from './SettingsSubheading.vue'

const props = withDefaults(defineProps<{ visibleSections?: string[] }>(), {
  visibleSections: () => []
})

const { logoIconUrl } = useAppBranding()
const { state } = useAppUpdater()

const showAbout = computed(() => props.visibleSections.length === 0 || props.visibleSections.includes('about'))

onMounted(async () => {
  if (state.currentVersion) return
  try {
    state.currentVersion = (await api.system.health()).version
  } catch { /* Version display is non-critical in browser mode. */ }
})
</script>

<template>
  <div
    v-if="showAbout"
    class="space-y-4"
  >
    <SettingsSubheading label="About Cynosure" />
    <BaseCard class="overflow-hidden">
      <div class="flex flex-col gap-5 p-5 sm:flex-row sm:items-center">
        <img
          :src="logoIconUrl"
          alt="Cynosure logo"
          class="h-20 w-20 shrink-0 object-contain"
        >
        <div class="min-w-0 flex-1">
          <h3 class="text-lg font-semibold text-theme-100">
            Cynosure
          </h3>
          <p class="mt-0.5 text-sm text-ink-muted">
            Version {{ state.currentVersion || 'unknown' }}
          </p>
        </div>
      </div>

      <div class="border-t border-theme-700 p-5">
        <AppUpdatePanel />
      </div>
    </BaseCard>
  </div>
</template>
