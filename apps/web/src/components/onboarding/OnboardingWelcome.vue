<template>
  <div class="flex min-h-full w-full items-center justify-center px-5 py-10 sm:px-8">
    <div class="w-full max-w-5xl text-center">
      <div class="logo-wrap mx-auto mb-7 flex h-20 w-20 items-center justify-center rounded-2xl">
        <img
          :src="logoIconUrl"
          alt="Cynosure"
          class="h-14 w-14 object-contain"
        >
      </div>

      <h1 class="mb-4 text-3xl font-semibold tracking-tight text-theme-100 sm:text-4xl">
        Welcome to <span class="text-accent-400">Cynosure</span>
      </h1>
      <p class="mx-auto max-w-xl text-sm leading-6 text-theme-400 sm:text-base">
        Your personal AI workspace. Build agents, connect tools, add memory,
        and let them work for you.
      </p>

      <label
        class="mx-auto mt-7 block max-w-sm text-left"
        for="onboarding-user-name"
      >
        <span class="mb-2 block text-sm font-medium text-theme-200">What should we call you?</span>
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
            placeholder="Your name"
            class="w-full rounded-xl border border-theme-700 bg-theme-900/80 py-3 pl-10 pr-3 text-sm text-theme-100 outline-none transition placeholder:text-theme-600 focus:border-accent-500 focus:ring-1 focus:ring-accent-500"
          >
        </div>
        <span class="mt-2 block text-xs leading-5 text-theme-500">
          This is stored in your settings and can be used by agents to address you personally.
        </span>
      </label>

      <div
        class="mx-auto my-8 flex max-w-xs items-center gap-2"
        aria-hidden="true"
      >
        <span class="h-px flex-1 bg-gradient-to-r from-transparent to-theme-700" />
        <span class="h-1.5 w-1.5 rounded-full bg-accent-400" />
        <span class="h-px flex-1 bg-gradient-to-l from-transparent to-theme-700" />
      </div>

      <div class="grid grid-cols-2 gap-y-8 sm:grid-cols-4 sm:gap-y-0">
        <div
          v-for="feature in features"
          :key="feature.title"
          class="feature-item px-3 sm:px-6"
        >
          <div
            class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl border"
            :class="[feature.iconBg, feature.iconBorder]"
          >
            <Icon
              :icon="feature.icon"
              class="h-5 w-5"
              :class="feature.iconColor"
            />
          </div>
          <h2 class="mb-1.5 text-sm font-semibold text-theme-200">
            {{ feature.title }}
          </h2>
          <p class="mx-auto max-w-44 text-xs leading-5 text-theme-500">
            {{ feature.description }}
          </p>
        </div>
      </div>

      <p class="mt-9 text-xs text-theme-600">
        You can change any of these settings later.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { useAppBranding } from '../../composables/useAppBranding'
import { usePreferencesStore } from '../../stores/preferences.store'

const { logoIconUrl } = useAppBranding()
const prefs = usePreferencesStore()

const features = [
  {
    title: 'Chat & Assist',
    description: 'Chat with any AI model and get things done.',
    icon: 'lucide:messages-square',
    iconBg: 'bg-cyan-500/10',
    iconBorder: 'border-cyan-500/25',
    iconColor: 'text-cyan-400',
  },
  {
    title: 'Build Agents',
    description: 'Create specialized agents with tools and memory.',
    icon: 'lucide:bot',
    iconBg: 'bg-purple-500/10',
    iconBorder: 'border-purple-500/25',
    iconColor: 'text-purple-400',
  },
  {
    title: 'Connect Tools',
    description: 'Add files, search, services, and more.',
    icon: 'lucide:wrench',
    iconBg: 'bg-amber-500/10',
    iconBorder: 'border-amber-500/25',
    iconColor: 'text-amber-400',
  },
  {
    title: 'Add Memory',
    description: 'Give agents knowledge and long-term context.',
    icon: 'lucide:brain',
    iconBg: 'bg-emerald-500/10',
    iconBorder: 'border-emerald-500/25',
    iconColor: 'text-emerald-400',
  },
]
</script>

<style scoped>
.logo-wrap {
  background: color-mix(in srgb, var(--color-theme-900) 88%, var(--color-accent-500));
  border: 1px solid color-mix(in srgb, var(--color-accent-500) 32%, transparent);
  box-shadow: 0 0 36px color-mix(in srgb, var(--color-accent-500) 18%, transparent);
}

@media (min-width: 640px) {
  .feature-item + .feature-item {
    border-left: 1px solid color-mix(in srgb, var(--color-theme-700) 55%, transparent);
  }
}
</style>
