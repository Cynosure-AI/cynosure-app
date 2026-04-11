<script setup lang="ts">
import { ref, computed } from 'vue'
import { useChatStore } from '../../stores/chat.store'
import { useAgentStore } from '../../stores/agent.store'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import { Icon } from '@iconify/vue'
import ModalDialog from '../shared/ModalDialog.vue'

const chatStore = useChatStore()
const agentStore = useAgentStore()
const agentDefs = useAgentDefinitionsStore()
const showClearConfirm = ref(false)

const clearLabel = computed(() => {
  if (chatStore.activeAgentId) {
    const agent = agentDefs.get(chatStore.activeAgentId)
    return agent?.name || 'this agent'
  }
  return 'Default'
})

async function selectChat(id: string): Promise<void> {
  await chatStore.selectConversation(id)
  await agentStore.restoreForConversation(id)
}

async function deleteChat(id: string, event: Event): Promise<void> {
  event.stopPropagation()
  await chatStore.deleteConversation(id)
}

async function togglePin(id: string, pinned: boolean, event: Event): Promise<void> {
  event.stopPropagation()
  await chatStore.pinConversation(id, !pinned)
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** Transform raw channel conversation titles into readable labels. */
function displayTitle(conv: { title: string; origin?: string }): string {
  if (conv.origin === 'channel') {
    const prefixes: Record<string, string> = { 'telegram:': 'Telegram', 'discord:': 'Discord', 'slack:': 'Slack' }
    for (const [prefix, label] of Object.entries(prefixes)) {
      if (conv.title.startsWith(prefix)) {
        const parts = conv.title.split('|')
        const senderName = parts[1] || 'Chat'
        const archivePart = parts.find(p => p.startsWith('archived:'))
        if (archivePart) {
          const ts = parseInt(archivePart.split(':')[1])
          return `${label}: ${senderName} · ${formatDate(ts)}`
        }
        return `${label}: ${senderName}`
      }
    }
  }
  return conv.title
}
</script>

<template>
  <div class="w-64 bg-zinc-950 border-r border-zinc-800/60 flex flex-col shrink-0 h-full">
    <!-- Header -->
    <div class="px-3 py-2.5 border-b border-zinc-800/60 flex items-center justify-between">
      <span class="text-xs font-medium text-zinc-500 uppercase tracking-wider">Chat History</span>
      <button
        v-if="chatStore.conversations.length > 0"
        class="p-1 rounded-md text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
        title="Clear all history"
        @click="showClearConfirm = true"
      >
        <Icon
          icon="lucide:trash-2"
          class="w-3.5 h-3.5"
        />
      </button>
    </div>

    <!-- Conversation list -->
    <div class="flex-1 overflow-y-auto">
      <div
        v-for="conv in chatStore.conversations"
        :key="conv.id"
        class="group flex items-center px-3 py-2.5 mx-2 my-0.5 rounded-lg cursor-pointer transition-colors hover:bg-zinc-800/60"
        :class="{ 'bg-zinc-800': conv.id === chatStore.activeConversationId }"
        @click="selectChat(conv.id)"
      >
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1.5">
            <Icon
              v-if="conv.pinned"
              icon="lucide:pin"
              class="w-3 h-3 shrink-0 text-amber-400"
            />
            <span
              class="text-sm truncate"
              :class="
                conv.id === chatStore.activeConversationId ? 'text-zinc-100' : 'text-zinc-400'
              "
            >
              {{ displayTitle(conv) }}
            </span>
            <span
              v-if="conv.origin && conv.origin !== 'chat'"
              class="shrink-0 text-[9px] font-medium px-1.5 py-0.5 rounded-full"
              :class="{
                'bg-purple-500/10 text-purple-400': conv.origin === 'channel',
                'bg-zinc-700/50 text-zinc-400': conv.origin !== 'channel'
              }"
            >
              {{ conv.origin }}
            </span>
          </div>
          <div class="text-xs text-zinc-600 mt-0.5">
            {{ formatDate(conv.updatedAt) }}
          </div>
        </div>
        <button
          class="opacity-0 group-hover:opacity-100 p-1 transition-all"
          :class="conv.pinned ? 'text-amber-400 hover:text-amber-300' : 'text-zinc-500 hover:text-amber-400'"
          :title="conv.pinned ? 'Unpin conversation' : 'Pin conversation'"
          @click="togglePin(conv.id, conv.pinned, $event)"
        >
          <Icon
            :icon="conv.pinned ? 'lucide:pin-off' : 'lucide:pin'"
            class="w-3.5 h-3.5"
          />
        </button>
        <button
          v-if="!conv.pinned"
          class="opacity-0 group-hover:opacity-100 p-1 text-zinc-500 hover:text-red-400 transition-all"
          @click="deleteChat(conv.id, $event)"
        >
          <Icon
            icon="lucide:x"
            class="w-3.5 h-3.5"
          />
        </button>
      </div>

      <div
        v-if="chatStore.conversations.length === 0"
        class="px-4 py-8 text-center text-zinc-600 text-sm"
      >
        No conversations yet
      </div>
    </div>

    <!-- Clear All Confirmation -->
    <ModalDialog
      :show="showClearConfirm"
      title="Clear Chat History"
      icon="lucide:trash-2"
      icon-color="red"
      @close="showClearConfirm = false"
    >
      <p class="text-zinc-400 leading-relaxed">
        Are you sure you want to delete all conversations for <strong class="text-zinc-200">{{ clearLabel }}</strong>? This action cannot be undone. Pinned conversations will be kept.
      </p>
      <template #actions>
        <button
          class="w-full px-4 py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl text-center font-medium transition-colors"
          @click="chatStore.deleteAllConversations(); showClearConfirm = false"
        >
          Delete All
        </button>
        <button
          class="w-full px-4 py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl text-center font-medium transition-colors"
          @click="showClearConfirm = false"
        >
          Cancel
        </button>
      </template>
    </ModalDialog>
  </div>
</template>
