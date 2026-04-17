<script setup lang="ts">
import { ref } from 'vue'
import { useChatStore } from '../../../stores/chat.store'
import { Icon } from '@iconify/vue'
import HoverTooltip from '../../shared/HoverTooltip.vue'
import SystemPromptModal from '../SystemPromptModal.vue'

const chatStore = useChatStore()

const showModal = ref(false)
</script>

<template>
  <HoverTooltip :max-width="320">
    <button
      class="relative p-2.5 rounded-xl transition-colors shrink-0 focus:outline-none focus:ring-1 focus:ring-blue-500"
      :class="chatStore.sessionSystemPrompt.trim()
        ? 'text-blue-400 hover:text-blue-300'
        : 'text-zinc-500 hover:text-zinc-300'"
      aria-label="System prompt"
      @click="showModal = true"
    >
      <Icon
        icon="lucide:scroll-text"
        class="h-5 w-5"
      />
    </button>
    <template #content>
      <div class="font-medium text-zinc-300 mb-1.5">
        System Prompt
      </div>
      <div
        v-if="chatStore.sessionSystemPrompt.trim()"
        class="text-zinc-400 text-[11px] whitespace-pre-wrap line-clamp-6 font-mono"
      >
        {{ chatStore.sessionSystemPrompt }}
      </div>
      <div
        v-else
        class="text-zinc-500"
      >
        No system prompt set
      </div>
      <div class="text-zinc-600 text-[10px] mt-1.5 border-t border-zinc-800 pt-1.5">
        Click to edit
      </div>
    </template>
  </HoverTooltip>

  <SystemPromptModal
    v-model="showModal"
    :system-prompt="chatStore.sessionSystemPrompt"
    @update:system-prompt="(v: string) => { chatStore.sessionSystemPrompt = v; chatStore.markOverridesModified() }"
  />
</template>
