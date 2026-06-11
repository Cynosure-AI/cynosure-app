<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { useRouter } from 'vue-router'
import { usePreferencesStore } from '../../stores/preferences.store'
import type { ThemeId } from '../../stores/preferences.store'
import { useOnboardingStore } from '../../stores/onboarding.store'
import ToggleSwitch from '../shared/ToggleSwitch.vue'
import BaseCard from '../shared/BaseCard.vue'

const prefs = usePreferencesStore()
const onboardingStore = useOnboardingStore()
const router = useRouter()
const props = withDefaults(defineProps<{
  visibleSections?: string[]
}>(), {
  visibleSections: () => []
})

function showSection(id: string): boolean {
  return props.visibleSections.length === 0 || props.visibleSections.includes(id)
}

function redoOnboarding() {
  onboardingStore.reset()
  router.push('/onboarding')
}

const themes: { id: ThemeId; label: string; icon: string; colors: { bg: string; surface: string; accent: string; text: string } }[] = [
  { id: 'dark', label: 'Dark', icon: 'lucide:moon', colors: { bg: '#141417', surface: '#202024', accent: '#3b82f6', text: '#f4f4f5' } },
  { id: 'light', label: 'Light', icon: 'lucide:sun', colors: { bg: '#eef2f7', surface: '#ffffff', accent: '#3b82f6', text: '#0f172a' } },
  { id: 'arasaka', label: 'Arasaka', icon: 'lucide:zap', colors: { bg: '#13090e', surface: '#1c1218', accent: '#00dce8', text: '#f0dce2' } },
  { id: 'midnight-purple', label: 'Midnight', icon: 'lucide:sparkles', colors: { bg: '#070915', surface: '#171a32', accent: '#a855f7', text: '#f1edff' } },
  { id: 'cyberpunk', label: 'Cyberpunk', icon: 'lucide:cpu', colors: { bg: '#111114', surface: '#181819', accent: '#f9f002', text: '#e8e8f0' } },
  { id: 'matrix', label: 'Matrix', icon: 'lucide:terminal', colors: { bg: '#030705', surface: '#0a120e', accent: '#00ff41', text: '#d8eed8' } },
  { id: 'sakura', label: 'Sakura', icon: 'lucide:flower-2', colors: { bg: '#170e1a', surface: '#241426', accent: '#f43f8f', text: '#ffe8f3' } },
]
</script>

<template>
  <div class="space-y-4">
    <!-- Theme -->
    <BaseCard
      v-if="showSection('theme')"
      class="p-5 space-y-4"
    >
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center">
          <Icon
            icon="lucide:palette"
            class="w-5 h-5 text-theme-400"
          />
        </div>
        <div>
          <h3 class="text-sm font-medium text-theme-200">
            Theme
          </h3>
          <p class="text-xs text-theme-500 mt-0.5">
            Choose your visual style
          </p>
        </div>
      </div>

      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <button
          v-for="t in themes"
          :key="t.id"
          class="group relative rounded-lg border-2 p-3 transition-all duration-200 text-left"
          :class="prefs.theme === t.id
            ? 'border-accent-500 ring-1 ring-accent-500/30'
            : 'border-theme-700 hover:border-theme-600'"
          @click="prefs.setTheme(t.id)"
        >
          <div
            class="rounded-md overflow-hidden mb-2.5 h-16 p-1.5 flex flex-col gap-1"
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

          <div
            v-if="prefs.theme === t.id"
            class="absolute top-1.5 right-1.5"
          >
            <Icon
              icon="lucide:check-circle-2"
              class="w-4 h-4 text-accent-400"
            />
          </div>
        </button>
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
              class="w-5 h-5 text-theme-400"
            />
          </div>
          <div>
            <h3 class="text-sm font-medium text-theme-200">
              Auto-expand Thinking
            </h3>
            <p class="text-xs text-theme-500 mt-0.5">
              Automatically expand thinking / reasoning blocks
            </p>
          </div>
        </div>
        <ToggleSwitch v-model="prefs.autoExpandSteps" />
      </div>
    </BaseCard>

    <!-- Auto-expand Tool Calls -->
    <BaseCard
      v-if="showSection('auto-expand-tool-calls')"
      class="p-5"
    >
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center">
            <Icon
              icon="lucide:terminal"
              class="w-5 h-5 text-theme-400"
            />
          </div>
          <div>
            <h3 class="text-sm font-medium text-theme-200">
              Auto-expand Tool Calls
            </h3>
            <p class="text-xs text-theme-500 mt-0.5">
              Automatically expand tool call details in the chat
            </p>
          </div>
        </div>
        <ToggleSwitch v-model="prefs.autoExpandToolCalls" />
      </div>
    </BaseCard>

    <!-- Onboarding -->
    <BaseCard
      v-if="showSection('setup-guide')"
      class="p-5"
    >
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center">
            <Icon
              icon="lucide:graduation-cap"
              class="w-5 h-5 text-theme-400"
            />
          </div>
          <div>
            <h3 class="text-sm font-medium text-theme-200">
              Setup Guide
            </h3>
            <p class="text-xs text-theme-500 mt-0.5">
              Re-run the onboarding flow to configure providers, memory and MCPs
            </p>
          </div>
        </div>
        <button
          class="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-theme-700 hover:bg-theme-600 text-theme-300 text-sm rounded-lg transition-colors"
          @click="redoOnboarding"
        >
          <Icon
            icon="lucide:refresh-cw"
            class="w-3.5 h-3.5"
          />
          Redo Setup
        </button>
      </div>
    </BaseCard>
  </div>
</template>
