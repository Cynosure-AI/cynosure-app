<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useChatStore } from '../stores/chat.store'
import { useAgentStore } from '../stores/agent.store'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import ChatHeaderBar from '../components/chat/ChatHeaderBar.vue'
import ChatPanel from '../components/chat/ChatPanel.vue'
import InputBar from '../components/chat/InputBar.vue'
import { api } from '../api/client'
import { Icon } from '@iconify/vue'

const route = useRoute()
const router = useRouter()
const chatStore = useChatStore()
const agentStore = useAgentStore()
const agentDefs = useAgentDefinitionsStore()

const agentId = computed(() => route.params.agentId as string)
const conversationIdParam = computed(() => route.query.conversation as string | undefined)
const instanceType = computed(() => (route.query.type as string) || 'chat')
const agent = computed(() => agentDefs.get(agentId.value))
const loading = ref(true)
const error = ref<string | null>(null)

const typeConfig: Record<string, { icon: string; color: string; label: string }> = {
  chat: { icon: 'lucide:message-circle', color: 'text-blue-400', label: 'Chat' },
  'multi-agent': { icon: 'lucide:network', color: 'text-purple-400', label: 'Multi-Agent' },
  cron: { icon: 'lucide:clock', color: 'text-sky-400', label: 'Cron' },
  channel: { icon: 'lucide:send', color: 'text-teal-400', label: 'Channel' }
}
const activeTypeConfig = computed(() => typeConfig[instanceType.value] || typeConfig.chat)

const inputBarRef = ref<InstanceType<typeof InputBar> | null>(null)
const isDragOver = ref(false)
let dragCounter = 0

function onDragEnter(e: DragEvent) {
  e.preventDefault()
  dragCounter++
  isDragOver.value = true
}

function onDragLeave(e: DragEvent) {
  e.preventDefault()
  dragCounter--
  if (dragCounter <= 0) {
    dragCounter = 0
    isDragOver.value = false
  }
}

function onDragOver(e: DragEvent) {
  e.preventDefault()
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  dragCounter = 0
  isDragOver.value = false
  const files = e.dataTransfer?.files
  if (files?.length && inputBarRef.value) {
    inputBarRef.value.processFiles(Array.from(files))
  }
}

onMounted(async () => {
  try {
    // Set the active agent so ChatPanel / InputBar context is correct
    await chatStore.setActiveAgent(agentId.value)

    // Use conversation ID from query if provided (from instances list)
    const targetConvId = conversationIdParam.value

    if (targetConvId) {
      await chatStore.selectConversation(targetConvId)
      await agentStore.restoreForConversation(targetConvId)
    } else {
      error.value = 'No active instance conversation found for this agent.'
    }
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden">
    <!-- Instance header -->
    <ChatHeaderBar
      mode="instance"
      back-route="/instances"
      :instance-type="activeTypeConfig.label"
      :instance-icon="activeTypeConfig.icon"
      :instance-color="activeTypeConfig.color"
    />

    <!-- Loading / Error states -->
    <div
      v-if="loading"
      class="flex-1 flex items-center justify-center text-zinc-500"
    >
      <Icon
        icon="lucide:loader-2"
        class="w-6 h-6 animate-spin"
      />
    </div>

    <div
      v-else-if="error"
      class="flex-1 flex items-center justify-center"
    >
      <div class="text-center max-w-md px-6">
        <Icon
          icon="lucide:inbox"
          class="w-12 h-12 text-zinc-700 mx-auto mb-3"
        />
        <p class="text-sm text-zinc-500">
          {{ error }}
        </p>
      </div>
    </div>

    <!-- Chat UI (instance-locked, no sidebar) -->
    <template v-else>
      <div
        class="flex flex-col flex-1 min-w-0 min-h-0 relative"
        @dragenter="onDragEnter"
        @dragleave="onDragLeave"
        @dragover="onDragOver"
        @drop="onDrop"
      >
        <ChatPanel />
        <InputBar ref="inputBarRef" />

        <div
          v-if="isDragOver"
          class="absolute inset-0 z-50 flex items-center justify-center bg-zinc-900/80 border-2 border-dashed border-blue-500 rounded-lg pointer-events-none"
        >
          <div class="text-center">
            <div class="text-4xl mb-2">
              📎
            </div>
            <div class="text-blue-400 text-sm font-medium">
              Drop files here
            </div>
            <div class="text-zinc-500 text-xs mt-1">
              Images &amp; text files supported
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
