<script setup lang="ts">
import { useChatStore } from '../../../stores/chat.store'
import ModalDialog from '../../shared/ModalDialog.vue'
import ToolSelector from '../../shared/ToolSelector.vue'
import ToggleSwitch from '../../shared/ToggleSwitch.vue'

const chatStore = useChatStore()

const visible = defineModel<boolean>({ required: true })

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
            <span class="text-xs font-medium text-theme-200">Auto Tool Mode</span>
            <span
              v-if="chatStore.sessionAutoToolRouting"
              class="text-[10px] px-1.5 py-0.5 rounded bg-accent-500/10 text-accent-300"
            >
              On
            </span>
          </div>
          <p class="mt-1 text-[11px] text-theme-500">
            Uses recent context to automatically choose a fitting tool collection. Selected tools are preferred in the decision-making. Model settings are configured in Preferences.
          </p>
        </div>
        <ToggleSwitch
          :model-value="chatStore.sessionAutoToolRouting"
          size="md"
          color="accent"
          @update:model-value="onAutoRoutingUpdate"
        />
      </div>
    </div>

    <ToolSelector
      :model-value="chatStore.selectedToolNames"
      :show-approvals="false"
      @update:model-value="onToolsUpdate"
    />
  </ModalDialog>
</template>
