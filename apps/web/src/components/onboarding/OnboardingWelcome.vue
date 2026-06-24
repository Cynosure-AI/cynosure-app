<template>
  <div class="max-w-3xl mx-auto px-4 py-7 w-full">
    <div class="relative overflow-hidden rounded-2xl border border-theme-700/60 bg-theme-900/70 px-6 py-7 mb-5">
      <div class="absolute -right-16 -top-20 w-56 h-56 rounded-full bg-accent-500/10 blur-3xl" />
      <div class="relative flex flex-col sm:flex-row items-center sm:items-start gap-5 text-center sm:text-left">
        <div class="w-20 h-20 rounded-2xl border border-accent-500/20 bg-accent-500/10 flex items-center justify-center shrink-0">
          <img
            :src="logoIconUrl"
            alt="Cynosure"
            class="w-14 h-14 object-contain drop-shadow-md"
          >
        </div>
        <div>
          <p class="text-xs font-semibold uppercase tracking-[0.2em] text-accent-400 mb-2">
            Your personal AI workspace
          </p>
          <h1 class="text-3xl font-bold text-theme-100 mb-2">
            Welcome to Cynosure
          </h1>
          <p class="text-theme-400 text-sm leading-relaxed max-w-xl">
            Build capable AI agents, give them tools and memory, then let them work through chat,
            schedules, and connected channels. We’ll get the essentials ready in three quick steps.
          </p>
        </div>
      </div>
    </div>

    <p class="text-xs font-semibold uppercase tracking-wider text-theme-500 mb-3 px-1">
      What you can do
    </p>
    <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
      <div
        v-for="feature in features"
        :key="feature.title"
        class="bg-theme-800/50 border border-theme-700/60 rounded-xl p-4 text-left"
      >
        <div
          class="w-9 h-9 rounded-lg flex items-center justify-center mb-3"
          :class="feature.iconBg"
        >
          <Icon
            :icon="feature.icon"
            class="w-4.5 h-4.5"
            :class="feature.iconColor"
          />
        </div>
        <p class="text-sm font-semibold text-theme-200 mb-1">
          {{ feature.title }}
        </p>
        <p class="text-xs text-theme-500 leading-relaxed">
          {{ feature.description }}
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { useAppBranding } from '../../composables/useAppBranding'

const { logoIconUrl } = useAppBranding()

const features = [
  {
    title: 'Chat with any model',
    description: 'Connect cloud or local AI providers and switch models whenever you need.',
    icon: 'lucide:messages-square',
    iconBg: 'bg-accent-500/15',
    iconColor: 'text-accent-400',
  },
  {
    title: 'Build specialized agents',
    description: 'Create reusable agents with their own prompts, models, tools, and permissions.',
    icon: 'lucide:bot',
    iconBg: 'bg-amber-500/15',
    iconColor: 'text-amber-400',
  },
  {
    title: 'Connect MCP tools',
    description: 'Add web search, files, email, desktop control, and many more capabilities.',
    icon: 'lucide:plug-zap',
    iconBg: 'bg-purple-500/15',
    iconColor: 'text-purple-400',
  },
  {
    title: 'Remember your knowledge',
    description: 'Index documents and conversations into searchable, long-term memory spaces.',
    icon: 'lucide:brain',
    iconBg: 'bg-emerald-500/15',
    iconColor: 'text-emerald-400',
  },
  {
    title: 'Automate recurring work',
    description: 'Run agents on schedules and keep an eye on active or completed executions.',
    icon: 'lucide:calendar-clock',
    iconBg: 'bg-cyan-500/15',
    iconColor: 'text-cyan-400',
  },
  {
    title: 'Work across channels',
    description: 'Bring agents into connected services and receive useful notifications.',
    icon: 'lucide:radio',
    iconBg: 'bg-rose-500/15',
    iconColor: 'text-rose-400',
  },
]
</script>
