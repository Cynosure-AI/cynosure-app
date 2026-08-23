<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { Icon } from '@iconify/vue'
import { api } from '../../api/client'
import { useAppBranding } from '../../composables/useAppBranding'
import { useAppUpdater } from '../../composables/useAppUpdater'
import BaseCard from '../shared/BaseCard.vue'
import SettingsSubheading from './SettingsSubheading.vue'

const props = withDefaults(defineProps<{ visibleSections?: string[] }>(), {
  visibleSections: () => []
})

const { logoIconUrl } = useAppBranding()
const { state, isElectron, progressPercent, check, download, install } = useAppUpdater()

const showAbout = computed(() => props.visibleSections.length === 0 || props.visibleSections.includes('about'))
const statusIcon = computed(() => ({
  available: 'lucide:download',
  downloading: 'lucide:loader-circle',
  downloaded: 'lucide:badge-check',
  'up-to-date': 'lucide:circle-check',
  checking: 'lucide:loader-circle',
  error: 'lucide:triangle-alert',
  unavailable: 'lucide:info',
  idle: 'lucide:refresh-cw'
}[state.status]))
const statusText = computed(() => {
  switch (state.status) {
    case 'checking': return 'Checking for updates…'
    case 'available': return `Version ${state.availableVersion} is available.`
    case 'downloading': return `Downloading version ${state.availableVersion}… ${progressPercent.value}%`
    case 'downloaded': return `Version ${state.availableVersion} is ready to install.`
    case 'up-to-date': return 'Cynosure is up to date.'
    case 'error': return state.message || 'Could not check for updates.'
    case 'unavailable': return isElectron.value
      ? (state.message || 'Updates are unavailable in this build.')
      : 'Automatic updates are only available in the Cynosure desktop app.'
    default: return 'Check whether a newer version of Cynosure is available.'
  }
})

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
          <p class="mt-0.5 text-sm text-theme-500">
            Version {{ state.currentVersion || 'unknown' }}
          </p>
        </div>
      </div>

      <div class="border-t border-theme-700 p-5">
        <div class="flex items-start gap-3">
          <Icon
            :icon="statusIcon"
            class="mt-0.5 h-5 w-5 shrink-0"
            :class="{
              'animate-spin text-theme-400': state.status === 'checking' || state.status === 'downloading',
              'text-emerald-400': state.status === 'up-to-date' || state.status === 'downloaded',
              'text-amber-400': state.status === 'available',
              'text-red-400': state.status === 'error',
              'text-theme-500': state.status === 'idle' || state.status === 'unavailable'
            }"
          />
          <div class="min-w-0 flex-1">
            <p class="text-sm text-theme-200">
              {{ statusText }}
            </p>
            <div
              v-if="state.status === 'downloading'"
              class="mt-3 h-1.5 overflow-hidden rounded-full bg-theme-700"
            >
              <div
                class="h-full rounded-full bg-accent-500 transition-[width]"
                :style="{ width: `${progressPercent}%` }"
              />
            </div>
          </div>
        </div>

        <div
          v-if="isElectron"
          class="mt-4 flex flex-wrap gap-2"
        >
          <button
            v-if="state.status === 'available'"
            type="button"
            class="rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-500"
            @click="download"
          >
            Download update
          </button>
          <button
            v-else-if="state.status === 'downloaded'"
            type="button"
            class="rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-500"
            @click="install"
          >
            Install and restart
          </button>
          <button
            v-else-if="['idle', 'up-to-date', 'error'].includes(state.status)"
            type="button"
            class="rounded-lg border border-theme-700 bg-theme-800 px-4 py-2 text-sm font-medium text-theme-200 transition hover:bg-theme-700"
            @click="check"
          >
            Check for updates
          </button>
        </div>
      </div>
    </BaseCard>
  </div>
</template>
