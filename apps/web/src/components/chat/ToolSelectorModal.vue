<script setup lang="ts">
import { useAgentStore } from '../../stores/agent.store'
import { useChatStore } from '../../stores/chat.store'
import { Icon } from '@iconify/vue'
import { watch } from 'vue'
import ToolSelector from '../shared/ToolSelector.vue'

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
  <Teleport to="body">
    <div
      v-if="visible"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      @click.self="closeModal"
    >
      <div
        class="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[560px] max-h-[70vh] flex flex-col"
      >
        <!-- Header -->
        <div class="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <h3 class="text-sm font-semibold text-zinc-200">
            Tool Access
          </h3>
          <button
            class="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
            @click="closeModal"
          >
            <Icon
              icon="mdi:close"
              class="h-4 w-4"
            />
          </button>
        </div>

        <!-- Reusable tool selector panel -->
        <ToolSelector
          class="min-h-0 flex-1 overflow-hidden"
          :model-value="agentStore.selectedToolNames"
          :show-approvals="false"
          @update:model-value="onToolsUpdate"
        />
      </div>
    </div>
  </Teleport>
</template>
