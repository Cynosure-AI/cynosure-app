<template>
  <div class="flex flex-col items-center justify-center text-center px-4 py-8 max-w-lg mx-auto">
    <img
      :src="logoIconUrl"
      alt="Cynosure"
      class="w-20 h-20 mb-6 object-contain drop-shadow-md "
    >
    <h1 class="text-3xl font-bold text-theme-100 mb-3">
      Welcome to Cynosure
    </h1>
    <p class="text-theme-400 text-base leading-relaxed mb-6">
      Your personal AI agent platform. Let's get you set up in just a few steps — connect an AI
      provider, optionally install tools and memory, and you'll be ready to go.
    </p>
    <div class="grid grid-cols-2 gap-3 w-full text-left">
      <div class="bg-theme-800/60 border border-theme-700/60 rounded-xl p-4">
        <div class="w-8 h-8 rounded-lg bg-accent-500/20 flex items-center justify-center mb-2">
          <Icon
            icon="lucide:cpu"
            class="w-4 h-4 text-accent-400"
          />
        </div>
        <p class="text-sm font-medium text-theme-200 mb-0.5">
          AI Providers
        </p>
        <p class="text-xs text-theme-500">
          Connect OpenAI, Anthropic, local models and more
        </p>
      </div>
      <div class="bg-theme-800/60 border border-theme-700/60 rounded-xl p-4">
        <div class="w-8 h-8 rounded-lg bg-purple-500/20 flex items-center justify-center mb-2">
          <Icon
            icon="lucide:plug"
            class="w-4 h-4 text-purple-400"
          />
        </div>
        <p class="text-sm font-medium text-theme-200 mb-0.5">
          MCP Tools
        </p>
        <p class="text-xs text-theme-500">
          Extend agents with browser, files, Gmail and more
        </p>
      </div>
      <div class="bg-theme-800/60 border border-theme-700/60 rounded-xl p-4">
        <div class="w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center mb-2">
          <Icon
            icon="lucide:brain"
            class="w-4 h-4 text-emerald-400"
          />
        </div>
        <p class="text-sm font-medium text-theme-200 mb-0.5">
          Memory
        </p>
        <p class="text-xs text-theme-500">
          Give your agents long-term, searchable memory
        </p>
      </div>
      <div class="bg-theme-800/60 border border-theme-700/60 rounded-xl p-4">
        <div class="w-8 h-8 rounded-lg bg-amber-500/20 flex items-center justify-center mb-2">
          <Icon
            icon="lucide:bot"
            class="w-4 h-4 text-amber-400"
          />
        </div>
        <p class="text-sm font-medium text-theme-200 mb-0.5">
          Agents
        </p>
        <p class="text-xs text-theme-500">
          Build and run autonomous AI agents
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { useAppBranding } from '../../composables/useAppBranding'

const { logoIconUrl } = useAppBranding()
</script>
