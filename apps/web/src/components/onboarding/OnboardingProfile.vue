<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { usePreferencesStore } from '../../stores/preferences.store'

const prefs = usePreferencesStore()
</script>

<template>
  <div class="flex min-h-full w-full items-center justify-center px-4 py-8">
    <div class="w-full max-w-lg">
      <div class="mb-6 flex h-12 w-12 items-center justify-center rounded-xl border border-accent-500/25 bg-accent-500/10">
        <Icon
          icon="lucide:hand"
          class="h-5 w-5 text-accent-fg"
        />
      </div>

      <h2 class="text-2xl font-bold text-theme-100">
        How should Cyno call you?
      </h2>
      <p class="mt-2 text-sm leading-relaxed text-theme-500">
        Add the name you’d like Cyno and your agents to use when speaking with you.
        You can change it later in Settings.
      </p>

      <label
        class="mt-7 block"
        for="onboarding-user-name"
      >
        <span class="mb-2 flex items-center justify-between gap-2 text-sm font-medium text-theme-200">
          <span>Your name</span>
          <span class="text-xs font-normal text-theme-600">Optional</span>
        </span>
        <div class="relative">
          <Icon
            icon="lucide:user-round"
            class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-500"
          />
          <input
            id="onboarding-user-name"
            v-model="prefs.userName"
            type="text"
            maxlength="100"
            autocomplete="name"
            autofocus
            placeholder="What should we call you?"
            class="w-full rounded-xl border border-theme-700 bg-theme-900/80 py-3 pl-10 pr-3 text-sm text-theme-100 outline-none transition placeholder:text-theme-600 focus:border-accent-500 focus:ring-1 focus:ring-accent-500"
          >
        </div>
      </label>

      <p class="mt-3 flex items-start gap-2 text-xs leading-5 text-theme-500">
        <Icon
          icon="lucide:info"
          class="mt-0.5 h-3.5 w-3.5 shrink-0"
        />
        Profile images can be added later from Settings → Appearance.
      </p>
    </div>
  </div>
</template>
