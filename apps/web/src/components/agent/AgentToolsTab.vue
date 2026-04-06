<script setup lang="ts">
import type { AgentDefinition } from '../../api/client'
import ToolSelector from '../shared/ToolSelector.vue'

defineProps<{ agent: AgentDefinition }>()
const emit = defineEmits<{ update: [field: string, value: unknown] }>()
</script>

<template>
  <div class="flex flex-col h-[60vh]">
    <p class="text-sm text-zinc-500 mb-3 shrink-0">
      Select which tools this agent can access
    </p>
    <ToolSelector
      class="flex-1 min-h-0"
      :model-value="agent.tools"
      :show-approvals="true"
      @update:model-value="emit('update', 'tools', $event)"
    />
  </div>
</template>
