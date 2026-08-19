<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAgentStore } from '../../../stores/agent-runtime.store'
import { useChatStore } from '../../../stores/chat.store'
import { Icon } from '@iconify/vue'
import HoverTooltip from '../../shared/HoverTooltip.vue'
import ToolSelectorModal from '../modals/ToolSelectorModal.vue'
import { isAgentRequiredBuiltInToolName, isAutoManagedBuiltInToolName } from '../../../utils/internal-tools'

const agentStore = useAgentStore()
const chatStore = useChatStore()

const showModal = ref(false)

const selectedToolsList = computed(() =>
  agentStore.availableTools.filter(t =>
    chatStore.selectedToolNames.includes(t.key)
  )
)

const selectableToolsList = computed(() =>
  agentStore.availableTools.filter(t =>
    !(t.namespace.id === 'builtin' && isAutoManagedBuiltInToolName(t.name)) &&
    (Boolean(chatStore.activeAgentId) || t.namespace.id !== 'builtin' || !isAgentRequiredBuiltInToolName(t.name))
  )
)

const missingTools = computed(() => {
  const availableKeys = new Set(selectableToolsList.value.map(t => t.key))
  return chatStore.selectedToolNames.filter(name => !availableKeys.has(name))
})
</script>

<template>
  <HoverTooltip
    v-if="agentStore.availableTools.length"
    :max-width="280"
  >
    <button
      class="relative p-2.5 rounded-xl transition-colors shrink-0 focus:outline-none focus:ring-1 focus:ring-accent-500 text-theme-500 hover:text-theme-300"
      aria-label="Tool access"
      @click="showModal = true"
    >
      <Icon
        icon="mdi:tools"
        class="h-5 w-5"
        :class="{ 'text-emerald-600': chatStore.sessionAutoToolRouting }"
      />
      <span
        v-if="missingTools.length"
        class="absolute -top-0.5 text-black -right-0.5 min-w-4 h-4 flex items-center justify-center rounded-full text-[9px] font-bold  px-1 leading-none bg-amber-500"
      >
        <Icon
          icon="lucide:alert-triangle"
          class="w-2.5 h-2.5"
        />
      </span>
      <span
        v-else-if="chatStore.sessionAutoToolRouting || chatStore.selectedToolNames.length"
        class="absolute -top-0.5 -right-0.5 min-w-4 h-4 flex items-center justify-center rounded-full text-[9px] font-bold text-white px-1 leading-none"
        :class="chatStore.sessionAutoToolRouting ? 'bg-emerald-600' : 'bg-accent-600'"
      >
        <Icon
          v-if="chatStore.sessionAutoToolRouting && !chatStore.selectedToolNames.length"
          icon="lucide:sparkles"
          class="w-2.5 h-2.5"
        />
        <template v-else>
          {{ chatStore.selectedToolNames.length }}
        </template>
      </span>
    </button>
    <template #content>
      <div class="font-medium text-theme-300 mb-1.5">
        Tools ({{ chatStore.selectedToolNames.length }}/{{ selectableToolsList.length }})
      </div>
      <div
        v-if="chatStore.sessionAutoToolRouting"
        class="mb-1.5 rounded border border-emerald-200 bg-emerald-50 px-1 py-1 text-[10px] font-medium text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300"
      >
        Auto-selection enabled
      </div>
      <template v-if="missingTools.length">
        <div class="mb-1.5 px-1 py-1 rounded bg-amber-100/60 border border-amber-400/30 dark:bg-amber-500/10 dark:border-amber-500/20">
          <div class="flex items-center gap-1 text-amber-600 dark:text-amber-400 text-[10px] font-medium mb-1">
            <Icon
              icon="lucide:alert-triangle"
              class="w-3 h-3 shrink-0"
            />
            {{ missingTools.length }} tool{{ missingTools.length > 1 ? 's' : '' }} unavailable
          </div>
          <div
            v-for="name in missingTools.slice(0, 5)"
            :key="name"
            class="text-amber-700/70 dark:text-amber-300/70 font-mono text-[10px] truncate pl-4"
          >
            {{ name }}
          </div>
          <div
            v-if="missingTools.length > 5"
            class="text-amber-500 dark:text-amber-400/50 text-[9px] pl-4"
          >
            +{{ missingTools.length - 5 }} more
          </div>
        </div>
      </template>
      <template v-if="selectedToolsList.length">
        <div
          v-for="t in selectedToolsList.slice(0, 12)"
          :key="t.name"
          class="flex items-start gap-1.5 mb-1 last:mb-0"
        >
          <Icon
            icon="lucide:check"
            class="w-3 h-3 text-emerald-400 shrink-0 mt-0.5"
          />
          <div class="min-w-0">
            <div class="text-theme-300 font-mono text-[11px] truncate">
              {{ t.name }}
            </div>
          </div>
        </div>
        <div
          v-if="selectedToolsList.length > 12"
          class="text-theme-500 text-[10px] mt-1"
        >
          +{{ selectedToolsList.length - 12 }} more
        </div>
      </template>
      <div
        v-else
        class="text-theme-500"
      >
        No tools selected
      </div>
      <div class="text-theme-600 text-[10px] mt-1.5 border-t border-theme-800 pt-1.5">
        Click to configure
      </div>
    </template>
  </HoverTooltip>

  <ToolSelectorModal v-model="showModal" />
</template>
