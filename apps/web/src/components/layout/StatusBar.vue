<script setup lang="ts">
import { useChatStore } from '../../stores/chat.store'
import { useProviderStore } from '../../stores/provider.store'
import { useAgentStore } from '../../stores/agent.store'
import { computed } from 'vue'

const chatStore = useChatStore()
const providerStore = useProviderStore()
const agentStore = useAgentStore()

const statusText = computed(() => {
  if (agentStore.isExecuting) return 'Agent running...'
  if (chatStore.isStreaming) return 'Streaming...'
  return 'Ready'
})

const tokenInfo = computed(() => {
  if (!chatStore.lastUsage) return null
  return `${chatStore.lastUsage.promptTokens} / ${chatStore.lastUsage.completionTokens} tokens`
})

const modelInfo = computed(() => {
  return chatStore.lastUsage?.model || providerStore.activeProvider?.defaultModel || ''
})
</script>

<template>
  <footer
    class="h-7 bg-zinc-950 border-t border-zinc-800 flex items-center px-4 text-xs text-zinc-500 gap-4 shrink-0 relative"
  >
    <span class="flex items-center gap-1.5">
      <span
        class="w-2 h-2 rounded-full"
        :class="{
          'bg-yellow-500 animate-pulse': chatStore.isStreaming,
          'bg-blue-500 animate-pulse': agentStore.isExecuting && !chatStore.isStreaming,
          'bg-green-500': !chatStore.isStreaming && !agentStore.isExecuting
        }"
      />
      {{ statusText }}
    </span>
    <span
      v-if="modelInfo"
      class="text-zinc-600"
    >{{ modelInfo }}</span>

    <div class="flex-1" />
    <span v-if="tokenInfo">{{ tokenInfo }}</span>
  </footer>
</template>
