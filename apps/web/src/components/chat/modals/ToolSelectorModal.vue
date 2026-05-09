<script setup lang="ts">
import { useAgentStore } from '../../../stores/agent-runtime.store'
import { useChatStore } from '../../../stores/chat.store'
import ModalDialog from '../../shared/ModalDialog.vue'
import ToolSelector from '../../shared/ToolSelector.vue'
import ToggleSwitch from '../../shared/ToggleSwitch.vue'

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
    icon-color="blue"
    max-width="max-w-2xl"
    @close="closeModal"
  >
    <div class="mb-3 rounded-xl border border-zinc-700 bg-zinc-900 p-3">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-xs font-medium text-zinc-200">Auto-select tools</span>
            <span
              v-if="chatStore.sessionAutoToolRouting"
              class="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-300"
            >
              Routing
            </span>
          </div>
          <p class="mt-1 text-[11px] text-zinc-500">
            Uses recent context to choose automatically a fitting tool collection. Selected tools are preferred in the decision-making. Router model is configured in Preferences.
          </p>
        </div>
        <ToggleSwitch
          :model-value="chatStore.sessionAutoToolRouting"
          size="md"
          color="blue"
          @update:model-value="onAutoRoutingUpdate"
        />
      </div>
    </div>

    <ToolSelector
      :model-value="agentStore.selectedToolNames"
      :show-approvals="false"
      @update:model-value="onToolsUpdate"
    />
  </ModalDialog>
</template>
