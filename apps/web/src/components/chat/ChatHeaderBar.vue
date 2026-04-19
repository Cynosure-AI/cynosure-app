<script setup lang="ts">
import { computed } from 'vue'
import { useChatStore } from '../../stores/chat.store'
import { useAgentStore } from '../../stores/agent-runtime.store'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import { Icon } from '@iconify/vue'
import ToggleSwitch from '../shared/ToggleSwitch.vue'
import { useChatSidebar } from '../../composables/useSidebar'
import { useRouter } from 'vue-router'

withDefaults(defineProps<{
  /** 'chat' = full selectors + sidebar toggle; 'instance' = read-only + back button */
  mode?: 'chat' | 'instance'
  /** Route for the back button (instance mode only) */
  backRoute?: string
  /** Instance type label (instance mode) */
  instanceType?: string
  /** Instance type icon (instance mode) */
  instanceIcon?: string
  /** Instance type color class (instance mode) */
  instanceColor?: string
}>(), {
  mode: 'chat',
  backRoute: '/instances',
  instanceType: '',
  instanceIcon: 'lucide:message-circle',
  instanceColor: 'text-blue-400',
})

const router = useRouter()
const chatStore = useChatStore()
const agentStore = useAgentStore()
const agentDefs = useAgentDefinitionsStore()
const { chatSidebarOpen, toggle: toggleSidebar } = useChatSidebar()

const selectedAgent = computed(() =>
  chatStore.activeAgentId ? agentDefs.get(chatStore.activeAgentId) : null
)

const conversationTitle = computed(() => chatStore.activeConversation?.title || '')

async function newChat(): Promise<void> {
  chatStore.startNewChat()
  agentStore.clearExecution()
}
</script>

<template>
  <div class="shrink-0 border-b border-zinc-800/60 px-3 py-2 flex items-center gap-2">
    <!-- ── Chat mode: sidebar toggle + title ── -->
    <template v-if="mode === 'chat'">
      <!-- Sidebar toggle -->
      <button
        class="p-1.5 rounded-lg hover:bg-zinc-800 transition-colors text-zinc-500 hover:text-zinc-300"
        title="Toggle chat history"
        @click="toggleSidebar"
      >
        <Icon
          :icon="chatSidebarOpen ? 'lucide:panel-left-close' : 'lucide:panel-left-open'"
          class="w-4 h-4"
        />
      </button>

      <!-- Agent icon (when an agent is selected) -->
      <img
        v-if="selectedAgent?.iconUrl"
        :src="selectedAgent.iconUrl"
        alt=""
        class="w-6 h-6 rounded-lg object-cover shrink-0"
      >
      <div
        v-else-if="selectedAgent"
        class="w-6 h-6 rounded-lg bg-zinc-800 flex items-center justify-center shrink-0"
      >
        <Icon
          icon="lucide:bot"
          class="w-3.5 h-3.5 text-zinc-500"
        />
      </div>

      <!-- Conversation / agent title -->
      <div class="min-w-0 flex-1">
        <span
          v-if="conversationTitle"
          class="text-sm font-medium text-zinc-200 truncate block"
        >
          {{ conversationTitle }}
        </span>
        <span
          v-else-if="selectedAgent"
          class="text-sm font-medium text-zinc-300 truncate block"
        >
          {{ selectedAgent.name }}
        </span>
        <span
          v-else
          class="text-sm text-zinc-500 truncate block"
        >
          New conversation
        </span>
      </div>

      <!-- Sub-agent override toggle -->
      <label
        v-if="(chatStore.sessionModelOverride || chatStore.sessionProviderOverride) && (selectedAgent?.subAgents?.length || chatStore.freeChatSubAgentIds?.length)"
        class="items-center gap-1.5 hidden md:flex cursor-pointer select-none shrink-0"
        :title="chatStore.sessionOverrideSubAgents ? 'Override applies to all sub-agents — click to restrict to main agent only' : 'Override applies to main agent only — click to propagate to sub-agents'"
      >
        <ToggleSwitch
          :model-value="chatStore.sessionOverrideSubAgents"
          size="sm"
          color="amber"
          @update:model-value="chatStore.sessionOverrideSubAgents = $event"
        />
        <span
          class="text-[10px]"
          :class="chatStore.sessionOverrideSubAgents ? 'text-amber-400' : 'text-zinc-500'"
        >
          Apply to All agents
        </span>
      </label>
    </template>

    <!-- ── Instance mode: back button + agent info ── -->
    <template v-else>
      <!-- Back button -->
      <button
        class="p-1.5 rounded-lg hover:bg-zinc-800 transition-colors text-zinc-500 hover:text-zinc-300"
        @click="router.push(backRoute)"
      >
        <Icon
          icon="lucide:arrow-left"
          class="w-4 h-4"
        />
      </button>

      <!-- Agent icon -->
      <img
        v-if="selectedAgent?.iconUrl"
        :src="selectedAgent.iconUrl"
        alt=""
        class="w-7 h-7 rounded-lg object-cover shrink-0"
      >
      <div
        v-else
        class="w-7 h-7 rounded-lg bg-zinc-800 flex items-center justify-center shrink-0"
      >
        <Icon
          icon="lucide:bot"
          class="w-4 h-4 text-zinc-500"
        />
      </div>

      <!-- Agent name + instance type -->
      <div class="min-w-0">
        <div class="text-sm font-medium text-zinc-200 truncate">
          {{ selectedAgent?.name || 'Agent' }}
        </div>
        <div
          v-if="instanceType"
          class="text-xs text-zinc-500 flex items-center gap-1.5"
        >
          <Icon
            :icon="instanceIcon"
            class="w-3 h-3"
            :class="instanceColor"
          />
          {{ instanceType }}
        </div>
      </div>

      <!-- Conversation title -->
      <span
        v-if="conversationTitle"
        class="text-xs text-zinc-500 truncate hidden sm:inline"
      >
        — {{ conversationTitle }}
      </span>

      <!-- Execution status -->
      <div class="flex items-center gap-1.5 ml-auto shrink-0">
        <span
          class="w-2 h-2 rounded-full"
          :class="agentStore.isExecuting ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-600'"
        />
        <span
          class="text-xs"
          :class="agentStore.isExecuting ? 'text-emerald-400' : 'text-zinc-500'"
        >{{ agentStore.isExecuting ? 'Running' : 'Idle' }}</span>
      </div>
    </template>

    <!-- ── Right section (chat mode only) ── -->
    <template v-if="mode === 'chat'">
      <div class="flex-1" />

      <!-- New Chat button -->
      <button
        class="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-medium transition-colors shrink-0"
        @click="newChat"
      >
        <Icon
          icon="lucide:plus"
          class="w-3.5 h-3.5"
        />
        <span class="hidden sm:inline">New Chat</span>
      </button>
    </template>
  </div>
</template>
