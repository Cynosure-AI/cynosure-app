<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { useRouter } from 'vue-router'
import { usePreferencesStore } from '../../stores/preferences.store'
import type { ThemeId } from '../../stores/preferences.store'
import { useOnboardingStore } from '../../stores/onboarding.store'
import ToggleSwitch from '../shared/ToggleSwitch.vue'
import BaseCard from '../shared/BaseCard.vue'
import SettingsSubheading from './SettingsSubheading.vue'
import SettingsPersistenceStatus, { type SettingsPersistenceState } from './SettingsPersistenceStatus.vue'
import IconUpload from '../shared/IconUpload.vue'
import { ref, watch } from 'vue'

const prefs = usePreferencesStore()
const onboardingStore = useOnboardingStore()
const router = useRouter()
const nameSaveError = ref('')
const profileStatus = ref<SettingsPersistenceState>('idle')
const lastSavedName = ref(prefs.userName)
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

function redoOnboarding() {
  onboardingStore.reset()
  router.push('/onboarding')
}

async function saveName() {
  nameSaveError.value = ''
  profileStatus.value = 'saving'
  try {
    await prefs.saveUserName()
    lastSavedName.value = prefs.userName
    profileStatus.value = 'saved'
  } catch {
    prefs.userName = lastSavedName.value
    nameSaveError.value = 'Could not save your name.'
    profileStatus.value = 'error'
  }
}

async function updateAvatar(value: string | null) {
  nameSaveError.value = ''
  const previous = prefs.userAvatarUrl
  prefs.userAvatarUrl = value
  profileStatus.value = 'saving'
  try {
    await prefs.saveUserProfile()
    lastSavedName.value = prefs.userName
    profileStatus.value = 'saved'
  } catch {
    prefs.userAvatarUrl = previous
    nameSaveError.value = 'Could not save your profile image.'
    profileStatus.value = 'error'
  }
}

watch(() => prefs.userSettingsLoaded, (loaded) => {
  if (loaded) lastSavedName.value = prefs.userName
}, { immediate: true })

const themes: { id: ThemeId; label: string; icon: string; colors: { bg: string; surface: string; accent: string; text: string } }[] = [
  { id: 'crimson', label: 'Crimson', icon: 'lucide:flame', colors: { bg: '#070708', surface: '#151517', accent: '#b80f1f', text: '#f4f2f4' } },
  { id: 'dark', label: 'Midnight', icon: 'lucide:moon', colors: { bg: '#141417', surface: '#202024', accent: '#3b82f6', text: '#f4f4f5' } },
  { id: 'light', label: 'Light', icon: 'lucide:sun', colors: { bg: '#eef2f7', surface: '#ffffff', accent: '#3b82f6', text: '#0f172a' } },
  { id: 'blackwall', label: 'Blackwall', icon: 'lucide:scan-eye', colors: { bg: '#050507', surface: '#0f0f12', accent: '#ff2e3b', text: '#eaeaea' } },
  { id: 'cyberpunk', label: 'Cyberpunk', icon: 'lucide:cpu', colors: { bg: '#111114', surface: '#181819', accent: '#f9f002', text: '#e8e8f0' } },
  { id: 'emerald', label: 'Emerald', icon: 'lucide:orbit', colors: { bg: '#03110c', surface: '#0b2419', accent: '#18b978', text: '#edf8f2' } },
  { id: 'industrial', label: 'Industrial', icon: 'lucide:factory', colors: { bg: '#100e0b', surface: '#211c16', accent: '#f59e0b', text: '#eee7d9' } },
  { id: 'monochrome', label: 'Monochrome', icon: 'lucide:circle-half', colors: { bg: '#080808', surface: '#181818', accent: '#f5f5f5', text: '#ededed' } },
]
</script>

<template>
  <div class="space-y-4">
    <SettingsSubheading
      v-if="showAnySection(['user-profile'])"
      label="Profile"
    />

    <BaseCard
      v-if="showSection('user-profile')"
      class="p-5"
    >
      <label
        class="flex items-start gap-3"
        for="settings-user-name"
      >
        <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-theme-900">
          <Icon
            icon="lucide:user-round"
            class="h-5 w-5 text-ink-secondary"
          />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block text-sm font-medium text-theme-200">Your name</span>
          <span class="mt-0.5 block text-xs text-ink-muted">
            Agents can reference this value with the <code
              v-pre
              class="text-accent-fg"
            >{{userName}}</code> smart tag.
          </span>
          <span class="mt-3 flex items-center gap-2">
            <input
              id="settings-user-name"
              v-model="prefs.userName"
              type="text"
              maxlength="100"
              :disabled="prefs.userSettingsSaving"
              autocomplete="name"
              placeholder="How should agents address you?"
              class="w-full max-w-md rounded-lg border border-theme-700 bg-theme-900 px-3 py-2 text-sm text-theme-100 outline-none transition placeholder:text-ink-faint focus:border-accent-500 focus:ring-1 focus:ring-accent-500"
              @change="saveName"
              @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
            >
            <Icon
              v-if="prefs.userSettingsSaving"
              icon="lucide:loader-2"
              class="h-4 w-4 animate-spin text-ink-muted"
            />
          </span>
          <span
            v-if="nameSaveError"
            class="mt-2 block text-xs text-status-danger"
          >{{ nameSaveError }}</span>
        </span>
      </label>

      <div class="mt-5 border-t border-theme-800 pt-5">
        <IconUpload
          :icon-url="prefs.userAvatarUrl"
          fallback-icon="lucide:user-round"
          label="Profile image"
          @update="updateAvatar"
        >
          <template #description>
            Used for your workspace profile and user messages in chat.
          </template>
        </IconUpload>
      </div>
      <div
        v-if="profileStatus === 'saving' || profileStatus === 'error'"
        class="mt-4 flex justify-end"
      >
        <SettingsPersistenceStatus
          mode="auto"
          :state="profileStatus"
        />
      </div>
    </BaseCard>

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
      v-if="showAnySection(['auto-expand-thinking'])"
      label="Chat Display"
    />

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

    <SettingsSubheading
      v-if="showAnySection(['setup-guide'])"
      label="Onboarding"
    />

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
              class="w-5 h-5 text-ink-secondary"
            />
          </div>
          <div>
            <h3 class="text-sm font-medium text-theme-200">
              Setup Guide
            </h3>
            <p class="text-xs text-ink-muted mt-0.5">
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
