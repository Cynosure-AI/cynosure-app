<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { usePreferencesStore } from '../../stores/preferences.store'
import type { ThemeId } from '../../stores/preferences.store'
import ToggleSwitch from '../shared/ToggleSwitch.vue'
import BaseCard from '../shared/BaseCard.vue'
import SettingsSubheading from './SettingsSubheading.vue'

const prefs = usePreferencesStore()
const props = withDefaults(defineProps<{
  visibleSections?: string[]
}>(), {
  visibleSections: () => []
})

function showSection(id: string): boolean {
  return props.visibleSections.length === 0 || props.visibleSections.includes(id)
}

function showAnySection(ids: string[]): boolean {
  return ids.some(showSection)
}

const themes: { id: ThemeId; label: string; icon: string; colors: { bg: string; surface: string; accent: string; text: string } }[] = [
  { id: 'crimson', label: 'Crimson', icon: 'lucide:flame', colors: { bg: '#070708', surface: '#151517', accent: '#b80f1f', text: '#f4f2f4' } },
  { id: 'dark', label: 'Midnight', icon: 'lucide:moon', colors: { bg: '#141417', surface: '#202024', accent: '#3b82f6', text: '#f4f4f5' } },
  { id: 'light', label: 'Light', icon: 'lucide:sun', colors: { bg: '#eef2f7', surface: '#ffffff', accent: '#3b82f6', text: '#0f172a' } },
  { id: 'blackwall', label: 'Blackwall', icon: 'lucide:scan-eye', colors: { bg: '#050507', surface: '#0f0f12', accent: '#ff2e3b', text: '#eaeaea' } },
  { id: 'cyberpunk', label: 'Cyberpunk', icon: 'lucide:cpu', colors: { bg: '#111114', surface: '#181819', accent: '#f9f002', text: '#e8e8f0' } },
  { id: 'emerald', label: 'Emerald', icon: 'lucide:sparkles', colors: { bg: '#070f0d', surface: '#182e25', accent: '#dbb86e', text: '#f6f3e7' } },
  { id: 'industrial', label: 'Industrial', icon: 'lucide:factory', colors: { bg: '#100e0b', surface: '#211c16', accent: '#f59e0b', text: '#eee7d9' } },
  { id: 'monochrome', label: 'Monochrome', icon: 'lucide:circle-half', colors: { bg: '#080808', surface: '#181818', accent: '#f5f5f5', text: '#ededed' } },
]
</script>

<template>
  <div class="space-y-4">
    <SettingsSubheading
      v-if="showAnySection(['theme'])"
      label="Theme"
    />

    <!-- Theme -->
    <BaseCard
      v-if="showSection('theme')"
      class="p-5 space-y-4"
    >
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center">
          <Icon
            icon="lucide:palette"
            class="w-5 h-5 text-ink-secondary"
          />
        </div>
        <div>
          <h3 class="text-sm font-medium text-theme-200">
            Theme
          </h3>
          <p class="text-xs text-ink-muted mt-0.5">
            Choose your visual style
          </p>
        </div>
      </div>

      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <button
          v-for="t in themes"
          :key="t.id"
          type="button"
          :aria-pressed="prefs.theme === t.id"
          :aria-label="`${t.label} theme${prefs.theme === t.id ? ', selected' : ''}`"
          class="group relative flex justify-center rounded-lg border-2 p-3 transition-all duration-200 text-left"
          :class="prefs.theme === t.id
            ? 'border-accent-500 ring-1 ring-accent-500/30'
            : 'border-theme-700 hover:border-theme-600'"
          @click="prefs.setTheme(t.id)"
        >
          <div class="w-fit flex flex-col items-start">
            <div
              class="rounded-md overflow-hidden mb-2.5 h-16 p-1.5 flex flex-col gap-1 w-28"
              :style="{ backgroundColor: t.colors.bg }"
            >
              <div class="flex gap-1 flex-1">
                <div
                  class="w-5 rounded-sm"
                  :style="{ backgroundColor: t.colors.surface }"
                />
                <div class="flex-1 flex flex-col gap-0.5">
                  <div
                    class="h-2 rounded-sm w-3/4"
                    :style="{ backgroundColor: t.colors.surface }"
                  />
                  <div
                    class="h-1.5 rounded-sm w-1/2 opacity-50"
                    :style="{ backgroundColor: t.colors.text }"
                  />
                  <div class="flex-1" />
                  <div
                    class="h-2 rounded-sm w-1/3"
                    :style="{ backgroundColor: t.colors.accent }"
                  />
                </div>
              </div>
            </div>

            <div class="flex items-center gap-2">
              <Icon
                :icon="t.icon"
                class="w-3.5 h-3.5"
                :style="{ color: t.colors.accent }"
              />
              <span class="text-xs font-medium text-theme-200">{{ t.label }}</span>
            </div>
          </div>

          <div
            v-if="prefs.theme === t.id"
            class="absolute top-1.5 right-1.5"
          >
            <Icon
              icon="lucide:check-circle-2"
              class="w-4 h-4 text-accent-fg"
            />
          </div>
        </button>
      </div>
    </BaseCard>

    <SettingsSubheading
      v-if="showAnySection(['ai-message-bubbles', 'auto-expand-thinking'])"
      label="Chat Display"
    />

    <BaseCard
      v-if="showSection('ai-message-bubbles')"
      class="p-5"
    >
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center">
            <Icon
              icon="lucide:message-square"
              class="w-5 h-5 text-ink-secondary"
            />
          </div>
          <div>
            <h3 class="text-sm font-medium text-theme-200">
              AI Message Bubbles
            </h3>
            <p class="text-xs text-ink-muted mt-0.5">
              Show backgrounds and borders around AI messages and thinking blocks
            </p>
          </div>
        </div>
        <ToggleSwitch
          v-model="prefs.aiMessageBubbles"
          label="AI message bubbles"
        />
      </div>
    </BaseCard>

    <!-- Auto-expand Thinking -->
    <BaseCard
      v-if="showSection('auto-expand-thinking')"
      class="p-5"
    >
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center">
            <Icon
              icon="lucide:list-tree"
              class="w-5 h-5 text-ink-secondary"
            />
          </div>
          <div>
            <h3 class="text-sm font-medium text-theme-200">
              Auto-expand Thinking
            </h3>
            <p class="text-xs text-ink-muted mt-0.5">
              Automatically expand thinking / reasoning blocks
            </p>
          </div>
        </div>
        <ToggleSwitch
          v-model="prefs.autoExpandSteps"
          label="Auto-expand thinking"
        />
      </div>
    </BaseCard>
  </div>
</template>
