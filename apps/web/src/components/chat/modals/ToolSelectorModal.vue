<script setup lang="ts">
import { useAgentStore } from '../../../stores/agent-runtime.store'
import { useChatStore } from '../../../stores/chat.store'
import ModalDialog from '../../shared/ModalDialog.vue'
import ToolSelector from '../../shared/ToolSelector.vue'

const agentStore = useAgentStore()
const chatStore = useChatStore()

const visible = defineModel<boolean>({ required: true })

function closeModal(): void {
  visible.value = false
}

function onToolsUpdate(tools: string[]) {
  agentStore.selectedToolNames = tools
  chatStore.markOverridesModified()
}
</script>

<template>
  <ModalDialog
    :show="visible"
    title="Tool Access"
    icon="mdi:tools"
    icon-color="blue"
    max-width="max-w-xl"
    @close="closeModal"
  >
    <ToolSelector
      :model-value="agentStore.selectedToolNames"
      :show-approvals="false"
      @update:model-value="onToolsUpdate"
    />
  </ModalDialog>
</template>
