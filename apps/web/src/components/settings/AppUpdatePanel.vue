<script setup lang="ts">
/* eslint-disable vue/no-v-html -- changelog HTML is sanitized by renderMarkdown. */
import { computed } from 'vue'
import { Icon } from '@iconify/vue'
import { useAppUpdater } from '../../composables/useAppUpdater'
import { handleMarkdownClick, renderMarkdown } from '../../utils/markdown'

const { state, isElectron, progressPercent, check, download, install } = useAppUpdater()

const renderedChangelog = computed(() => state.changelogMarkdown
  ? renderMarkdown(state.changelogMarkdown)
  : '')
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
</script>

<template>
  <div>
    <div class="flex items-start gap-3">
      <Icon
        :icon="statusIcon"
        class="mt-0.5 h-5 w-5 shrink-0"
        :class="{
          'animate-spin text-ink-secondary': state.status === 'checking' || state.status === 'downloading',
          'text-status-success': state.status === 'up-to-date' || state.status === 'downloaded',
          'text-status-warning': state.status === 'available',
          'text-status-danger': state.status === 'error',
          'text-ink-muted': state.status === 'idle' || state.status === 'unavailable'
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
        class="rounded-lg accent-action bg-accent-600 px-4 py-2 text-sm font-medium text-accent-on transition hover:bg-accent-500"
        @click="download"
      >
        Download update
      </button>
      <button
        v-else-if="state.status === 'downloaded'"
        type="button"
        class="rounded-lg accent-action bg-accent-600 px-4 py-2 text-sm font-medium text-accent-on transition hover:bg-accent-500"
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

    <div
      v-if="renderedChangelog && ['available', 'downloading', 'downloaded'].includes(state.status)"
      class="mt-5 border-t border-theme-700 pt-5"
    >
      <div
        class="msg-markdown text-sm text-theme-300"
        @click="handleMarkdownClick"
        v-html="renderedChangelog"
      />
    </div>
  </div>
</template>
