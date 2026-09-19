<script setup lang="ts">
import { computed } from 'vue'
import { useChatStore } from '../../../stores/chat.store'
import ModalDialog from '../../shared/ModalDialog.vue'
import ToolSelector from '../../shared/ToolSelector.vue'
import ToggleSwitch from '../../shared/ToggleSwitch.vue'
import { memoryAutomaticToolStates } from '../../../utils/internal-tools'
import { DIRECT_TOOL_SELECTION_LIMIT } from '@shared/runtime-limits'

const chatStore = useChatStore()

const visible = defineModel<boolean>({ required: true })

const hasMemoryScope = computed(() => chatStore.freeChatMemoryFolderIds.length > 0)
const hasConversationAttachment = computed(() => chatStore.messages.some((message) => (message.fileAttachments?.length ?? 0) > 0))
const hasSelectableExecutionTools = computed(() => chatStore.selectedToolNames.length > 0 || chatStore.sessionAutoToolRouting)
const usesSelectionCapRouting = computed(() => chatStore.selectedToolNames.length > DIRECT_TOOL_SELECTION_LIMIT)

const automaticToolStates = computed(() => ({
  todo_write: {
    active: chatStore.sessionThinkingEnabled && hasSelectableExecutionTools.value,
    criteria: 'thinking mode and visible execution tools',
  },
  ...memoryAutomaticToolStates(hasMemoryScope.value),
  knowledge_search: {
    active: hasMemoryScope.value,
    criteria: 'memory folder selected',
  },
  attachment_search: {
    active: hasConversationAttachment.value,
    criteria: 'large indexed attachment available',
  },
  attachment_read: {
    active: hasConversationAttachment.value,
    criteria: 'large indexed attachment available',
  },
  expand_available_toolset: {
    active: chatStore.sessionAutoToolRouting || usesSelectionCapRouting.value,
    criteria: `auto tool mode enabled or more than ${DIRECT_TOOL_SELECTION_LIMIT} tools selected`,
  },
  spawn_subagent: {
    active: chatStore.freeChatSubAgentIds.length > 0,
    criteria: 'sub-agent selected',
  },
  continue_subagent: {
    active: chatStore.freeChatSubAgentIds.length > 0,
    criteria: 'sub-agent selected',
  },
}))

function closeModal(): void {
  visible.value = false
}

function onToolsUpdate(tools: string[]) {
  chatStore.setSelectedToolNames(tools)
}

function onAutoRoutingUpdate(enabled: boolean): void {
  chatStore.sessionAutoToolRouting = enabled
  chatStore.markOverridesModified()
}
</script>

<template>
  <ModalDialog
    :show="visible"
    title="Tool Access"
    icon="mdi:tools"
    icon-color="accent"
    max-width="max-w-2xl"
    @close="closeModal"
  >
    <div class="mb-3 rounded-xl border border-theme-700 bg-theme-900 p-3">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-xs font-medium text-theme-200">Automatic tool discovery</span>
            <span
              v-if="chatStore.sessionAutoToolRouting || usesSelectionCapRouting"
              class="text-[10px] px-1.5 py-0.5 rounded bg-accent-500/10 text-accent-300"
            >
              {{ chatStore.sessionAutoToolRouting ? 'On' : `Auto for ${chatStore.selectedToolNames.length} tools` }}
            </span>
          </div>
          <p class="mt-1 text-[11px] text-theme-500">
            Uses recent context to discover a compact tool set. Up to {{ DIRECT_TOOL_SELECTION_LIMIT }} selected tools are sent directly and remain pinned. Above that limit, a relevant subset is selected automatically from only those tools, even when this switch is off. Context routing uses the current agent / selected model by default; agent overrides are configured in the Advanced tab.
          </p>
        </div>
        <ToggleSwitch
          :model-value="chatStore.sessionAutoToolRouting"
          label="Automatic tool discovery"
          size="md"
          color="accent"
          @update:model-value="onAutoRoutingUpdate"
        />
      </div>
    </div>

    <ToolSelector
      :model-value="chatStore.selectedToolNames"
      :show-approvals="false"
      :automatic-tool-states="automaticToolStates"
      @update:model-value="onToolsUpdate"
    />
  </ModalDialog>
</template>
