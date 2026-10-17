<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { useRouter } from 'vue-router'
import { usePreferencesStore } from '../../stores/preferences.store'
import { useOnboardingStore } from '../../stores/onboarding.store'
import BaseCard from '../shared/BaseCard.vue'
import SettingsSubheading from './SettingsSubheading.vue'
import SettingsPersistenceStatus, { type SettingsPersistenceState } from './SettingsPersistenceStatus.vue'
import IconUpload from '../shared/IconUpload.vue'
import { ref, watch } from 'vue'

const prefs = usePreferencesStore()
const onboardingStore = useOnboardingStore()
const router = useRouter()
const nameSaveError = ref('')
const instructionsSaveError = ref('')
const profileStatus = ref<SettingsPersistenceState>('idle')
const lastSavedName = ref(prefs.userName)
const lastSavedInstructions = ref(prefs.userInstructions)
const MAX_INSTRUCTIONS_LENGTH = 4000
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

async function saveInstructions() {
  if (prefs.userInstructions === lastSavedInstructions.value) return
  instructionsSaveError.value = ''
  profileStatus.value = 'saving'
  try {
    await prefs.saveUserProfile()
    lastSavedName.value = prefs.userName
    lastSavedInstructions.value = prefs.userInstructions
    profileStatus.value = 'saved'
  } catch {
    prefs.userInstructions = lastSavedInstructions.value
    instructionsSaveError.value = 'Could not save your instructions.'
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
  if (!loaded) return
  lastSavedName.value = prefs.userName
  lastSavedInstructions.value = prefs.userInstructions
}, { immediate: true })
</script>

<template>
  <div class="space-y-4">
    <SettingsSubheading
      v-if="showAnySection(['user-profile'])"
      label="Profile"
    />

    <BaseCard
      v-if="showSection('user-profile')"
      class="divide-y divide-theme-800 px-5"
    >
      <div class="py-5">
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

      <div class="py-5">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <label
            for="settings-user-name"
            class="text-sm font-medium text-theme-200"
          >What should Cyno call you?</label>
          <span class="flex items-center gap-2 sm:w-72">
            <input
              id="settings-user-name"
              v-model="prefs.userName"
              type="text"
              maxlength="100"
              :disabled="prefs.userSettingsSaving"
              autocomplete="name"
              placeholder="Your name"
              class="w-full rounded-lg border border-theme-700 bg-theme-900 px-3 py-2 text-sm text-theme-100 outline-none transition placeholder:text-ink-faint focus:border-accent-500 focus:ring-1 focus:ring-accent-500"
              @change="saveName"
              @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
            >
          </span>
        </div>
        <p
          v-if="nameSaveError"
          class="mt-2 text-xs text-status-danger"
        >
          {{ nameSaveError }}
        </p>
      </div>

      <div class="py-5">
        <label
          for="settings-user-instructions"
          class="block text-sm font-medium text-theme-200"
        >Instructions for Cyno</label>
        <p class="mt-1 text-xs leading-5 text-ink-muted">
          Cyno and your agents follow these in every chat, so you don't have to repeat them,
          for example how you like things explained or how long answers should be.
        </p>
        <textarea
          id="settings-user-instructions"
          v-model="prefs.userInstructions"
          rows="4"
          :maxlength="MAX_INSTRUCTIONS_LENGTH"
          :disabled="!prefs.userSettingsLoaded"
          placeholder="e.g. Keep explanations short and precise"
          class="mt-3 block w-full resize-y rounded-lg border border-theme-700 bg-theme-900 px-3 py-2 text-sm leading-6 text-theme-100 outline-none transition placeholder:text-ink-faint focus:border-accent-500 focus:ring-1 focus:ring-accent-500"
          @change="saveInstructions"
        />
        <div class="mt-1.5 flex items-start justify-between gap-3">
          <p
            v-if="instructionsSaveError"
            class="text-xs text-status-danger"
          >
            {{ instructionsSaveError }}
          </p>
          <span
            v-if="prefs.userInstructions.length > MAX_INSTRUCTIONS_LENGTH * 0.8"
            class="ml-auto text-xs tabular-nums text-ink-faint"
          >{{ prefs.userInstructions.length }} / {{ MAX_INSTRUCTIONS_LENGTH }}</span>
        </div>
      </div>

      <div
        v-if="profileStatus === 'saving' || profileStatus === 'error'"
        class="flex justify-end py-4"
      >
        <SettingsPersistenceStatus
          mode="auto"
          :state="profileStatus"
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
