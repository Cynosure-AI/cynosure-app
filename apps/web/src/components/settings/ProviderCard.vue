<script setup lang="ts">
import type { LLMProviderConfig } from '../../api/types'
import { useProviderLogos } from '../../composables/useProviderLogos'

defineProps<{
  provider: LLMProviderConfig
  isLastUsed: boolean
  isTesting: boolean
  testStatus?: boolean
}>()

const emit = defineEmits<{
  test: [providerId: string]
  edit: [provider: LLMProviderConfig]
  remove: [providerId: string]
}>()

const { providerLogos } = useProviderLogos()

function getProviderIcon(type: string): string {
  const icons: Record<string, string> = {
    openai: 'O',
    anthropic: 'A',
    google: 'G',
    lmstudio: 'L',
    grok: 'X',
    ollama: 'O',
    openrouter: 'R',
    requesty: 'R',
    groq: 'G',
    mistral: 'M'
  }
  return icons[type] || '?'
}
</script>

<template>
  <div class="bg-theme-800 border border-theme-700 rounded-xl p-4 flex items-center gap-4">
    <div class="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 bg-theme-900 p-1.5">
      <img
        v-if="providerLogos[provider.type]"
        :src="providerLogos[provider.type].dark"
        :alt="provider.type"
        class="w-full h-full object-contain dark:block hidden"
      >
      <img
        v-if="providerLogos[provider.type]"
        :src="providerLogos[provider.type].light"
        :alt="provider.type"
        class="w-full h-full object-contain dark:hidden block"
      >
      <span
        v-else
        class="text-lg font-bold text-theme-400"
      >{{ getProviderIcon(provider.type) }}</span>
    </div>

    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-2">
        <span class="font-medium text-theme-200">{{ provider.name }}</span>
        <span
          v-if="isLastUsed"
          class="text-[10px] px-1.5 py-0.5 rounded-full bg-accent-500/20 text-accent-400 font-medium"
        >Last used</span>
      </div>
      <div class="text-sm text-theme-500 truncate">
        {{ provider.defaultModel }} · {{ provider.type }}
      </div>
    </div>

    <div class="flex items-center gap-2">
      <button
        :disabled="isTesting"
        class="px-2.5 py-1 text-xs rounded-md transition-colors"
        :class="
          testStatus === true
            ? 'bg-green-600/20 text-green-400'
            : testStatus === false
              ? 'bg-red-600/20 text-red-400'
              : 'bg-theme-700 hover:bg-theme-600 text-theme-300'
        "
        @click="emit('test', provider.id)"
      >
        {{
          isTesting
            ? 'Testing...'
            : testStatus === true
              ? 'Connected'
              : testStatus === false
                ? 'Failed'
                : 'Test'
        }}
      </button>
      <button
        class="px-2.5 py-1 text-xs bg-theme-700 hover:bg-theme-600 text-theme-300 rounded-md transition-colors"
        @click="emit('edit', provider)"
      >
        Edit
      </button>
      <button
        type="button"
        class="p-1 text-theme-500 hover:text-red-400 transition-colors"
        :aria-label="`Remove ${provider.name}`"
        @click="emit('remove', provider.id)"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="h-4 w-4"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fill-rule="evenodd"
            d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z"
            clip-rule="evenodd"
          />
        </svg>
      </button>
    </div>
  </div>
</template>
